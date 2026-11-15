/* Dabernaz Cloudflare Pages Function: authentication, D1 accounts and live Daberna rooms. */
import { nextTournamentStartAt, buildTournamentStages, makeTournamentCard, scoreTournamentPlayers } from '../tournament-rules.mjs';

const REGISTRATION_WINDOW_MS = 150000;
const MAX_CARDS_PER_PLAYER = 5;
const MIN_PLAYERS_TO_START = 2;
const ROOM_ECONOMICS = Object.freeze({
  room5000: { price: 5000, linePrizePercent: 10, fullPrizePercent: 75, commissionPercent: 15 },
  room10000: { price: 10000, linePrizePercent: 10, fullPrizePercent: 75, commissionPercent: 15 },
  room20000: { price: 20000, linePrizePercent: 10, fullPrizePercent: 75, commissionPercent: 15 },
  room50000: { price: 50000, linePrizePercent: 10, fullPrizePercent: 75, commissionPercent: 15 },
});
const DRAW_INTERVAL_MS = 3000;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 100000;
const ROOM_IDS = ['room5000', 'room10000', 'room20000', 'room50000'];
const encoder = new TextEncoder();
const bootstrappedBindings = new WeakSet();

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...headers,
    },
  });
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return new Uint8Array();
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(length) {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

function randomInt(max) {
  if (!Number.isInteger(max) || max < 1) throw new TypeError('Invalid random range');
  const range = 0x100000000;
  const limit = range - (range % max);
  const sample = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(sample);
    value = sample[0];
  } while (value >= limit);
  return value % max;
}

function randomToken(length = 32) {
  return bytesToHex(randomBytes(length));
}

async function sha256Hex(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PASSWORD_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${PASSWORD_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(bits)}`;
}

async function verifyPassword(password, stored) {
  try {
    const [kind, roundsText, saltText, digestText] = String(stored).split('$');
    const rounds = Number(roundsText);
    if (kind !== 'pbkdf2' || !Number.isInteger(rounds) || rounds < 50000 || rounds > 100000) return false;
    const salt = hexToBytes(saltText);
    const expected = hexToBytes(digestText);
    if (salt.length !== 16 || expected.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const actual = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' }, key, 256,
    ));
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch (_) {
    return false;
  }
}

async function ensureSchema(db) {
  if (bootstrappedBindings.has(db)) return;
  // Base definitions also allow a new, empty D1 database to initialize automatically.
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    phone TEXT,
    password_hash TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    bingo_coins INTEGER NOT NULL DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS game_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    game_type TEXT NOT NULL,
    result TEXT NOT NULL,
    prize INTEGER NOT NULL DEFAULT 0,
    bingo_coins_earned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_id INTEGER NOT NULL,
    invited_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (inviter_id) REFERENCES users(id),
    FOREIGN KEY (invited_user_id) REFERENCES users(id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS game_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entry_fee INTEGER NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 20,
    status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();

  const info = await db.prepare('PRAGMA table_info(users)').all();
  const columns = new Set((info.results || []).map((item) => item.name));
  const additions = [
    ['email', 'TEXT'],
    ['member_id', 'TEXT'],
    ['games_played', 'INTEGER NOT NULL DEFAULT 0'],
    ['wins', 'INTEGER NOT NULL DEFAULT 0'],
    ['points', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      try { await db.prepare(`ALTER TABLE users ADD COLUMN ${name} ${definition}`).run(); }
      catch (error) {
        // Allows simultaneous first requests to race safely on the same schema migration.
        if (!String(error?.message || error).toLowerCase().includes('duplicate column')) throw error;
      }
    }
  }

  const statements = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_member_id ON users(member_id) WHERE member_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_user_type ON transactions(user_id, type, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_game_results_user ON game_results(user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS game_sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, game_type TEXT NOT NULL, state_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'playing', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))`,
    `CREATE INDEX IF NOT EXISTS idx_game_sessions_user_status ON game_sessions(user_id,status,updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS auth_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      email TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_auth_attempts_lookup ON auth_attempts(ip, email, attempted_at)`,
    `CREATE TABLE IF NOT EXISTS room_states (
      room_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS room_locks (
      room_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS room_finances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL,
      total_players INTEGER NOT NULL,
      total_cards INTEGER NOT NULL,
      gross_revenue INTEGER NOT NULL,
      line_prize_paid INTEGER NOT NULL,
      full_prize_paid INTEGER NOT NULL,
      site_commission INTEGER NOT NULL,
      finished_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_room_finances_room_created ON room_finances(room_id, id DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_invited ON referrals(invited_user_id)`,
    `CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS tournament_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_type TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      entry_cost INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tournament_type, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tournament_entries_type ON tournament_entries(tournament_type, id)`,
    `CREATE TABLE IF NOT EXISTS tournament_rooms (
      tournament_type TEXT PRIMARY KEY,
      capacity INTEGER NOT NULL DEFAULT 30,
      registered_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'registration',
      updated_at TEXT NOT NULL
    )`,
  ];
  for (const sql of statements) await db.prepare(sql).run();
  const financeInfoAfterCreate = await db.prepare('PRAGMA table_info(room_finances)').all();
  const financeColumnsAfterCreate = new Set((financeInfoAfterCreate.results || []).map((item) => item.name));
  for (const [name, definition] of [['line_winners_json', "TEXT NOT NULL DEFAULT '[]'"], ['full_winners_json', "TEXT NOT NULL DEFAULT '[]'"]]) {
    if (!financeColumnsAfterCreate.has(name)) {
      try { await db.prepare(`ALTER TABLE room_finances ADD COLUMN ${name} ${definition}`).run(); }
      catch (error) { if (!String(error?.message || error).toLowerCase().includes('duplicate column')) throw error; }
    }
  }
  const tournamentNow = new Date().toISOString();
  for (const type of ['simple','bingo']) {
    await db.prepare(`INSERT INTO tournament_rooms (tournament_type, capacity, registered_count, status, updated_at)
      VALUES (?, 30, (SELECT COUNT(*) FROM tournament_entries WHERE tournament_type = ? AND status = 'registered'),
        CASE WHEN (SELECT COUNT(*) FROM tournament_entries WHERE tournament_type = ? AND status = 'registered') >= 30 THEN 'full' ELSE 'registration' END, ?)
      ON CONFLICT(tournament_type) DO NOTHING`).bind(type, type, type, tournamentNow).run();
  }
  bootstrappedBindings.add(db);
}

function parseCookies(request) {
  const raw = request.headers.get('cookie') || '';
  const result = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `dabernaz_session=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

function expiredCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `dabernaz_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

async function createSession(db, userId) {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(hash, userId, now + SESSION_SECONDS, now).run();
  return token;
}

async function authenticatedUser(db, request) {
  const token = parseCookies(request).dabernaz_session;
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) return null;
  const hash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(`SELECT u.* FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`).bind(hash, now).first();
  if (!row) {
    await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  return row;
}

async function coinHistory(db, userId) {
  const result = await db.prepare(`SELECT amount, description, created_at FROM transactions
    WHERE user_id = ? AND type = 'bingo_coin' ORDER BY id DESC LIMIT 50`).bind(userId).all();
  return (result.results || []).map((row) => ({
    amount: Number(row.amount) || 0,
    title: row.description || 'تراکنش بینگوکوین',
    date: row.created_at || '',
  }));
}

async function publicUser(db, row) {
  return {
    id: String(row.id),
    name: row.username,
    email: row.email || '',
    memberId: String(row.member_id || ''),
    createdAt: row.created_at || '',
    balance: Math.max(0, Number(row.balance) || 0),
    stats: {
      gamesPlayed: Number(row.games_played) || 0,
      wins: Number(row.wins) || 0,
      points: Number(row.points) || 0,
    },
    bingoCoins: Number(row.bingo_coins) || 0,
    coinTransactions: await coinHistory(db, row.id),
  };
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 32768) throw new HttpError(413, 'درخواست بیش از حد بزرگ است.');
  const raw = await request.text();
  if (raw.length > 32768) throw new HttpError(413, 'درخواست بیش از حد بزرگ است.');
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
    return data;
  } catch (_) {
    throw new HttpError(400, 'داده ارسالی معتبر نیست.');
  }
}

function validateWriteOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'مبدأ درخواست معتبر نیست.');
  if (!origin && request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    throw new HttpError(403, 'مبدأ درخواست معتبر نیست.');
  }
}

async function checkAuthRate(db, request, email) {
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM auth_attempts
    WHERE ip = ? AND email = ? AND attempted_at > ?`).bind(ip, email, now - 600).first();
  if (Number(count?.n || 0) >= 10) throw new HttpError(429, 'تعداد تلاش‌ها زیاد است. ده دقیقه بعد دوباره تلاش کن.');
  await db.prepare('INSERT INTO auth_attempts (ip, email, attempted_at) VALUES (?, ?, ?)').bind(ip, email, now).run();
  await db.prepare('DELETE FROM auth_attempts WHERE attempted_at < ?').bind(now - 3600).run();
  return { ip, email };
}

async function handleAuth(db, request, path) {
  if (request.method === 'GET' && path === '/api/auth/me') {
    const row = await authenticatedUser(db, request);
    return json({ ok: true, user: row ? await publicUser(db, row) : null });
  }

  if (request.method === 'POST' && path === '/api/auth/logout') {
    validateWriteOrigin(request);
    const token = parseCookies(request).dabernaz_session;
    if (token && /^[0-9a-f]{64}$/i.test(token)) {
      const hash = await sha256Hex(token);
      // Logging out only ends authentication. A purchased room ticket remains
      // committed to the shared round; it must not disappear from other players'
      // room counters or be cancelled by switching accounts in the same browser.
      await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(hash).run();
    }
    return json({ ok: true }, 200, { 'set-cookie': expiredCookie(request) });
  }

  if (request.method === 'POST' && (path === '/api/auth/register' || path === '/api/auth/login')) {
    validateWriteOrigin(request);
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) throw new HttpError(400, 'ایمیل معتبر وارد کن.');
    if (password.length < 8 || password.length > 128) throw new HttpError(400, 'رمز عبور باید بین ۸ تا ۱۲۸ نویسه باشد.');
    await checkAuthRate(db, request, email);

    let userRow;
    if (path === '/api/auth/register') {
      const name = String(body.name || '').trim();
      const nameLength = [...name].length;
      if (nameLength < 2 || nameLength > 32) throw new HttpError(400, 'نام نمایشی باید بین ۲ تا ۳۲ نویسه باشد.');
      const existing = await db.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').bind(email).first();
      if (existing) throw new HttpError(409, 'با این ایمیل قبلاً حساب ساخته شده است.');
      let memberId;
      for (let attempt = 0; attempt < 30; attempt++) {
        memberId = String(100000 + randomInt(900000));
        const used = await db.prepare('SELECT id FROM users WHERE member_id = ? LIMIT 1').bind(memberId).first();
        if (!used) break;
        memberId = null;
      }
      if (!memberId) throw new HttpError(503, 'ساخت شناسه بازیکن ناموفق بود؛ دوباره تلاش کن.');
      const passwordHash = await hashPassword(password);
      const referralCode = `DABERNAZ${memberId}`;
      const referralInput = String(body.referralCode || '').trim().toUpperCase();
      let inviter = null;
      if (referralInput) {
        inviter = await db.prepare('SELECT id, referral_code FROM users WHERE referral_code = ? LIMIT 1').bind(referralInput).first();
        if (!inviter) throw new HttpError(400, 'کد دعوت معتبر نیست.');
      }
      try {
        await db.prepare(`INSERT INTO users
          (username, email, member_id, password_hash, balance, bingo_coins, referral_code, games_played, wins, points, created_at)
          VALUES (?, ?, ?, ?, 0, 0, ?, 0, 0, 0, ?)`)
          .bind(name, email, memberId, passwordHash, referralCode, new Date().toISOString()).run();
      } catch (error) {
        const message = String(error?.message || error);
        if (/unique constraint failed|constraint failed/i.test(message)) {
          throw new HttpError(409, 'این ایمیل، نام نمایشی یا شناسه قبلاً ثبت شده است.');
        }
        throw error;
      }
      userRow = await db.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').bind(email).first();
      if (!userRow) throw new Error('User row was not available after successful registration insert.');
      if (inviter && Number(inviter.id) !== Number(userRow.id)) {
        await db.prepare('INSERT INTO referrals (inviter_id, invited_user_id, created_at) VALUES (?, ?, ?)')
          .bind(inviter.id, userRow.id, new Date().toISOString()).run();
        const referralCount = await db.prepare('SELECT COUNT(*) AS n FROM referrals WHERE inviter_id = ?').bind(inviter.id).first();
        const milestones = Math.floor(Number(referralCount?.n || 0) / 5);
        const rewarded = await db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND type = 'referral_reward'`).bind(inviter.id).first();
        const alreadyRewarded = Number(rewarded?.n || 0);
        if (milestones > alreadyRewarded) {
          const nowText = new Date().toISOString();
          for (let milestone = alreadyRewarded + 1; milestone <= milestones; milestone++) {
            await db.batch([
              db.prepare('UPDATE users SET balance = balance + 20000, bingo_coins = bingo_coins + 5 WHERE id = ?').bind(inviter.id),
              db.prepare(`INSERT INTO transactions (user_id, type, amount, description, created_at) VALUES (?, 'referral_reward', 20000, ?, ?)`).bind(inviter.id, `پاداش ${milestone * 5} دعوت موفق`, nowText),
              db.prepare(`INSERT INTO transactions (user_id, type, amount, description, created_at) VALUES (?, 'bingo_coin', 5, ?, ?)`).bind(inviter.id, `۵ بینگوکوین پاداش ${milestone * 5} دعوت موفق`, nowText),
            ]);
          }
        }
      }
    } else {
      userRow = await db.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').bind(email).first();
      const valid = userRow ? await verifyPassword(password, userRow.password_hash) : false;
      if (!valid) throw new HttpError(401, 'ایمیل یا رمز عبور اشتباه است.');
    }

    const user = await publicUser(db, userRow);
    let token;
    try {
      token = await createSession(db, userRow.id);
    } catch (error) {
      // A failed session insert must not leave a newly registered, unusable account behind.
      if (path === '/api/auth/register') {
        await db.batch([
          db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(userRow.id),
          db.prepare('DELETE FROM users WHERE id = ?').bind(userRow.id),
        ]).catch((cleanupError) => console.error('[dabernaz-register-rollback-failed]', String(cleanupError?.message || cleanupError)));
      }
      throw error;
    }
    return json({ ok: true, user }, 200, { 'set-cookie': sessionCookie(token, request) });
  }
  return null;
}

function newRoom(roomId) {
  return {
    id: roomId, status: 'waiting', queue: [], cardCounts: {}, queuedCards: {},
    queuedNames: {}, entryPayments: {}, players: [], calledNumbers: [],
    winners: { line: [], full: [] }, roundId: null, totalPlayers: 0, totalCards: 0,
    grossRevenue: 0, linePrizePaid: 0, fullPrizePaid: 0, siteCommission: 0,
    commissionFinalized: false, registrationStartedAt: null, registrationDeadline: null,
    startedAt: null, finishedAt: null, nextDrawAt: null, updatedAt: Date.now(),
  };
}

async function loadRoom(db, roomId) {
  const row = await db.prepare('SELECT payload FROM room_states WHERE room_id = ?').bind(roomId).first();
  if (row?.payload) {
    try {
      const room = JSON.parse(row.payload);
      room.queue ||= []; room.players ||= []; room.entryPayments ||= {};
      room.cardCounts ||= {}; room.queuedCards ||= {}; room.queuedNames ||= {};
      room.winners ||= { line: [], full: [] };
      if (!Array.isArray(room.winners.line)) room.winners.line = room.winners.line ? [room.winners.line] : [];
      if (!Array.isArray(room.winners.full)) room.winners.full = room.winners.full ? [room.winners.full] : [];
      room.roundId ??= null; room.totalPlayers ||= 0; room.totalCards ||= 0;
      room.grossRevenue ||= 0; room.linePrizePaid ||= 0; room.fullPrizePaid ||= 0;
      room.siteCommission ||= 0; room.commissionFinalized ||= false;
      room.registrationStartedAt ??= null; room.registrationDeadline ??= null;
      // One-time migration for a queue created by the previous room rules.
      if (room.status === 'waiting' && room.queue.length && !room.registrationDeadline) {
        room.registrationStartedAt = Date.now();
        room.registrationDeadline = room.registrationStartedAt + REGISTRATION_WINDOW_MS;
        await saveRoom(db, room);
      }
      return room;
    } catch (error) {
      console.error('[dabernaz-room-state-corrupt]', JSON.stringify({ roomId, message:String(error?.message || error) }));
      throw new HttpError(500, 'اطلاعات اتاق قابل خواندن نیست؛ برای جلوگیری از پاک شدن صف، اتاق بازنشانی نشد.');
    }
  }
  const room = newRoom(roomId);
  await saveRoom(db, room);
  return room;
}

async function saveRoom(db, room, awards = []) {
  room.updatedAt = Date.now();
  const statements = [db.prepare(`INSERT INTO room_states (room_id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
    .bind(room.id, JSON.stringify(room), room.updatedAt)];
  for (const award of awards) {
    if (award.kind === 'balance') {
      statements.push(db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(award.amount, award.userId));
      statements.push(db.prepare(`INSERT INTO transactions (user_id, type, amount, description, created_at)
        VALUES (?, 'balance', ?, ?, ?)`).bind(award.userId, award.amount, award.description, award.createdAt));
    } else if (award.kind === 'room_commission') {
      statements.push(db.prepare(`INSERT INTO room_finances
        (round_id, room_id, total_players, total_cards, gross_revenue, line_prize_paid, full_prize_paid, site_commission, line_winners_json, full_winners_json, finished_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(round_id) DO NOTHING`)
        .bind(award.roundId, award.roomId, award.totalPlayers, award.totalCards, award.grossRevenue,
          award.linePrizePaid, award.fullPrizePaid, award.siteCommission, JSON.stringify(award.lineWinners || []), JSON.stringify(award.fullWinners || []), award.finishedAt, award.createdAt));
    } else {
      statements.push(db.prepare('UPDATE users SET bingo_coins = bingo_coins + ? WHERE id = ?').bind(award.amount, award.userId));
      statements.push(db.prepare(`INSERT INTO transactions (user_id, type, amount, description, created_at)
        VALUES (?, 'bingo_coin', ?, ?, ?)`).bind(award.userId, award.amount, award.description, award.createdAt));
    }
  }
  // D1 batch is transactional: room winner state and its BGC rewards commit together.
  await db.batch(statements);
}

async function cancelExpiredWaitingRoom(db, room, reason = 'حداقل دو بازیکن در مهلت ثبت‌نام کارت نخریدند؛ مبلغ خرید کارت بازگردانده شد.') {
  const createdAt = new Date().toISOString();
  const awards = Object.entries(room.entryPayments || [])
    .map(([userId, amount]) => ({ userId:Number(userId), amount:Math.max(0, Math.floor(Number(amount) || 0)) }))
    .filter((item) => Number.isInteger(item.userId) && item.userId > 0 && item.amount > 0)
    .map((item) => ({ kind:'balance', userId:item.userId, amount:item.amount, description:reason, createdAt }));
  const reset = newRoom(room.id);
  await saveRoom(db, reset, awards);
  return reset;
}

async function withRoomLock(db, roomId, callback) {
  const token = randomToken(16);
  let acquired = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    // Refresh the clock on each attempt. A timestamp captured before waiting can
    // otherwise prevent acquisition even after a previous lease has expired.
    const now = Date.now();
    const lock = await db.prepare(`INSERT INTO room_locks (room_id, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
      WHERE room_locks.expires_at < ?
      RETURNING token`)
      .bind(roomId, token, now + 30000, now).first();
    if (lock?.token === token) { acquired = true; break; }
    // Room writes are serialized in D1. Wait longer for neighboring joins
    // instead of rejecting valid players during a short burst of activity.
    await new Promise((resolve) => setTimeout(resolve, Math.min(45 + attempt * 10, 150) + randomInt(60)));
  }
  if (!acquired) throw new HttpError(409, 'اتاق در حال به‌روزرسانی است؛ چند لحظه دیگر دوباره تلاش کن.');
  try { return await callback(); }
  finally { await db.prepare('DELETE FROM room_locks WHERE room_id = ? AND token = ?').bind(roomId, token).run(); }
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function makeCard() {
  const grid = Array.from({ length: 3 }, () => Array(9).fill(false));
  for (let row = 0; row < 3; row++) {
    const columns = shuffle(Array.from({ length: 9 }, (_, i) => i));
    for (const col of columns.slice(0, 5)) grid[row][col] = true;
  }
  const counts = Array(9).fill(0);
  for (let col = 0; col < 9; col++) for (let row = 0; row < 3; row++) if (grid[row][col]) counts[col]++;
  for (let missing = 0; missing < 9; missing++) {
    if (counts[missing] > 0) continue;
    const moves = [];
    for (let row = 0; row < 3; row++) {
      if (grid[row][missing]) continue;
      for (let donor = 0; donor < 9; donor++) if (grid[row][donor] && counts[donor] > 1) moves.push([row, donor]);
    }
    if (!moves.length) throw new Error('ساخت کارت معتبر ممکن نشد.');
    const [row, donor] = moves[randomInt(moves.length)];
    grid[row][donor] = false;
    grid[row][missing] = true;
    counts[donor]--;
    counts[missing]++;
  }
  const card = grid.map((row) => row.map((occupied) => occupied ? 0 : null));
  for (let col = 0; col < 9; col++) {
    const min = col === 0 ? 1 : col * 10;
    const max = col === 8 ? 90 : col * 10 + 9;
    const places = [];
    for (let row = 0; row < 3; row++) if (card[row][col] === 0) places.push(row);
    const values = shuffle(Array.from({ length: max - min + 1 }, (_, i) => min + i)).slice(0, places.length).sort((a, b) => a - b);
    places.forEach((row, index) => { card[row][col] = values[index]; });
  }
  return card;
}

function lineComplete(card, called) {
  const set = new Set(called);
  return card.some((row) => {
    const numbers = row.filter(Number.isInteger);
    return numbers.length === 5 && numbers.every((n) => set.has(n));
  });
}

function fullComplete(card, called) {
  const numbers = card.flat().filter(Number.isInteger);
  const set = new Set(called);
  return numbers.length === 15 && numbers.every((n) => set.has(n));
}

async function startRoom(db, room) {
  const ids = [...new Set((room.queue || []).map(Number).filter(Number.isInteger))];
  if (ids.length < MIN_PLAYERS_TO_START) return false;
  const byId = new Map();
  // Chunk lookups so a room has no hidden bind-parameter capacity.
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => '?').join(',');
    const query = await db.prepare(`SELECT id, username, member_id FROM users WHERE id IN (${placeholders})`).bind(...chunk).all();
    for (const row of query.results || []) byId.set(Number(row.id), row);
  }
  const players = [];
  for (const id of ids) {
    const row = byId.get(id);
    const cards = Array.isArray(room.queuedCards?.[String(id)]) ? room.queuedCards[String(id)] : [];
    if (row && cards.length) players.push({ userId:id, name:row.username, memberId:String(row.member_id || ''), cards });
  }
  const totalCards = players.reduce((sum, player) => sum + player.cards.length, 0);
  if (players.length < MIN_PLAYERS_TO_START || totalCards < MIN_PLAYERS_TO_START) return false;
  room.players = players;
  room.totalPlayers = players.length;
  room.totalCards = totalCards;
  room.grossRevenue = Object.values(room.entryPayments || {}).reduce((sum, amount) => sum + Math.max(0, Number(amount) || 0), 0);
  room.roundId = randomToken(16);
  room.linePrizePaid = 0; room.fullPrizePaid = 0; room.siteCommission = 0; room.commissionFinalized = false;
  room.queue = []; room.queuedCards = {}; room.queuedNames = {}; room.cardCounts = {};
  room.status = 'playing'; room.calledNumbers = []; room.winners = { line: [], full: [] };
  room.startedAt = Math.floor(Date.now() / 1000);
  room.finishedAt = null;
  room.nextDrawAt = Date.now() + DRAW_INTERVAL_MS;
  return true;
}

function advanceRoom(room) {
  if (room.status !== 'playing' || !room.nextDrawAt) return { changed: false, awards: [] };
  let changed = false;
  let guard = 0;
  const awards = [];
  const now = Date.now();
  while (room.status === 'playing' && room.nextDrawAt <= now && guard < 90) {
    guard++;
    const remaining = Array.from({ length: 90 }, (_, i) => i + 1).filter((n) => !room.calledNumbers.includes(n));
    if (!remaining.length) {
      room.status = 'finished';
      room.finishedAt = Math.floor(Date.now() / 1000);
      room.nextDrawAt = null;
      changed = true;
      break;
    }
    const number = remaining[randomInt(remaining.length)];
    room.calledNumbers.push(number);
    const called = new Set(room.calledNumbers);

    room.winners ||= { line: [], full: [] };
    if (!Array.isArray(room.winners.line)) room.winners.line = room.winners.line ? [room.winners.line] : [];
    if (!Array.isArray(room.winners.full)) room.winners.full = room.winners.full ? [room.winners.full] : [];

    // Everyone whose card first becomes complete on the same announced number wins together.
    // Winners are unique players, even if one player owns multiple completed cards.
    const collectWinners = (checkComplete) => {
      const byUser = new Map();
      for (const player of room.players) {
        if ((player.cards || []).some((card) => checkComplete(card, called))) {
          byUser.set(String(player.userId), {
            userId: player.userId,
            name: player.name,
            memberId: player.memberId,
            number,
            at: Math.floor(Date.now() / 1000),
          });
        }
      }
      return Array.from(byUser.values());
    };
    const splitPrize = (totalPrize, winners, description) => {
      const total = Math.max(0, Number(totalPrize) || 0);
      if (!total || !winners.length) return [];
      const base = Math.floor(total / winners.length);
      const remainder = total % winners.length;
      const createdAt = new Date().toISOString();
      return winners.map((winner, index) => ({
        kind:'balance',
        userId:winner.userId,
        amount:base + (index < remainder ? 1 : 0),
        description,
        createdAt,
      })).filter((award) => award.amount > 0);
    };

    if (!room.winners.line.length) {
      const lineWinners = collectWinners(lineComplete);
      if (lineWinners.length) {
        room.winners.line = lineWinners;
        const prize = Math.floor((Number(room.grossRevenue) || 0) * (Number(ROOM_ECONOMICS[room.id]?.linePrizePercent) || 0) / 100);
        room.linePrizePaid = prize;
        awards.push(...splitPrize(prize, lineWinners, 'سهم جایزه یک خط دبرنا'));
      }
    }
    if (!room.winners.full.length) {
      const fullWinners = collectWinners(fullComplete);
      if (fullWinners.length) {
        room.winners.full = fullWinners;
        const prize = Math.floor((Number(room.grossRevenue) || 0) * (Number(ROOM_ECONOMICS[room.id]?.fullPrizePercent) || 0) / 100);
        room.fullPrizePaid = prize;
        awards.push(...splitPrize(prize, fullWinners, 'سهم جایزه دبرنای کامل'));
      }
    }
    room.nextDrawAt += DRAW_INTERVAL_MS;
    changed = true;
    if ((room.winners.line?.length && room.winners.full?.length) || room.calledNumbers.length >= 90) {
      room.status = 'finished';
      room.finishedAt = Math.floor(Date.now() / 1000);
      room.nextDrawAt = null;
    }
  }
  if (room.status === 'finished' && room.roundId && !room.commissionFinalized) {
    const grossRevenue = Math.max(0, Number(room.grossRevenue) || 0);
    const linePrizePaid = Math.max(0, Number(room.linePrizePaid) || 0);
    const fullPrizePaid = Math.max(0, Number(room.fullPrizePaid) || 0);
    const siteCommission = grossRevenue - linePrizePaid - fullPrizePaid;
    if (siteCommission < 0) {
      throw new HttpError(500, 'جمع جوایز از درآمد کارت‌های این سانس بیشتر شده است؛ ثبت کمیسیون متوقف شد.');
    }
    room.siteCommission = siteCommission;
    room.commissionFinalized = true;
    const now = new Date().toISOString();
    awards.push({
      kind: 'room_commission',
      roundId: room.roundId,
      roomId: room.id,
      totalPlayers: Number(room.totalPlayers) || room.players.length,
      totalCards: Number(room.totalCards) || room.players.reduce((total, player) => total + (player.cards?.length || 0), 0),
      grossRevenue,
      linePrizePaid,
      fullPrizePaid,
      siteCommission,
      lineWinners: Array.isArray(room.winners?.line) ? room.winners.line : [],
      fullWinners: Array.isArray(room.winners?.full) ? room.winners.full : [],
      finishedAt: room.finishedAt ? new Date(room.finishedAt * 1000).toISOString() : now,
      createdAt: now,
    });
    changed = true;
  }
  return { changed, awards };
}

async function publicRoom(db, room, userId) {
  const me = room.players.find((player) => Number(player.userId) === Number(userId));
  const queued = room.queue.some((id) => Number(id) === Number(userId));
  const account = await db.prepare('SELECT bingo_coins FROM users WHERE id = ?').bind(userId).first();
  const grossRevenue = room.roundId
    ? Math.max(0, Number(room.grossRevenue) || 0)
    : Object.values(room.entryPayments || {}).reduce((sum, amount) => sum + Math.max(0, Number(amount) || 0), 0);
  const economics = ROOM_ECONOMICS[room.id] || null;
  const linePrize = economics ? Math.floor(grossRevenue * economics.linePrizePercent / 100) : 0;
  const fullPrize = economics ? Math.floor(grossRevenue * economics.fullPrizePercent / 100) : 0;
  const commission = grossRevenue - linePrize - fullPrize;
  return {
    id:room.id, status:room.status, capacity:null, minPlayersToStart:MIN_PLAYERS_TO_START,
    maxCardsPerPlayer:MAX_CARDS_PER_PLAYER, registrationWindowMs:REGISTRATION_WINDOW_MS,
    registrationStartedAt:room.registrationStartedAt || null,
    registrationDeadline:room.registrationDeadline || null,
    registrationRemainingMs:room.status === 'waiting' && room.registrationDeadline
      ? Math.max(0, Number(room.registrationDeadline) - Date.now()) : null,
    economics:{price:Number(economics?.price) || 0}, grossRevenue,
    estimatedPrizes:{line:linePrize,full:fullPrize},
    finance:room.roundId ? {
      totalPlayers:Number(room.totalPlayers) || room.players.length,
      totalCards:Number(room.totalCards) || room.players.reduce((sum, player) => sum + (player.cards?.length || 0), 0),
      grossRevenue, linePrizePaid:Number(room.linePrizePaid) || 0, fullPrizePaid:Number(room.fullPrizePaid) || 0,
      siteCommission:room.commissionFinalized ? Number(room.siteCommission) || 0 : null,
      finalized:!!room.commissionFinalized,
    } : null,
    playerCount:room.status === 'waiting' ? room.queue.length : room.players.length,
    cardCount:room.status === 'waiting'
      ? Object.values(room.cardCounts || {}).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0)
      : (Number(room.totalCards) || room.players.reduce((sum, player) => sum + (player.cards?.length || 0), 0)),
    queueCount:room.status === 'waiting' ? room.queue.length : room.players.length,
    players:room.status === 'waiting'
      ? room.queue.map(id => ({name:room.queuedNames?.[String(id)] || 'بازیکن',memberId:''}))
      : room.players.map(player => ({name:player.name,memberId:player.memberId})),
    calledNumbers:room.calledNumbers.slice(-15), allCalledNumbers:room.calledNumbers,
    drawCount:room.calledNumbers.length,
    latestNumber:room.calledNumbers.length ? room.calledNumbers[room.calledNumbers.length - 1] : null,
    winners:room.winners,
    myCards:room.status === 'finished' ? [] : (me?.cards || (queued ? (room.queuedCards[String(userId)] || []) : [])),
    joined:room.status === 'finished' ? false : (queued || !!me), startedAt:room.startedAt, finishedAt:room.finishedAt,
    myBingoCoins:Number(account?.bingo_coins) || 0,
    myCoinTransactions:await coinHistory(db, userId),
  };
}

async function handleRoom(db, request, user, path) {
  const match = path.match(/^\/api\/rooms\/(room5000|room10000|room20000|room50000)(?:\/(join|leave))?$/);
  if (!match) return null;
  const [, roomId, action = ''] = match;
  const userId = Number(user.id);

  if (request.method === 'GET' && !action) {
    let room = await loadRoom(db, roomId);
    const expired = room.status === 'waiting' && room.registrationDeadline && Number(room.registrationDeadline) <= Date.now();
    const drawDue = room.status === 'playing' && room.nextDrawAt && room.nextDrawAt <= Date.now();
    if (expired || drawDue) {
      await withRoomLock(db, roomId, async () => {
        room = await loadRoom(db, roomId);
        let started = false;
        if (room.status === 'waiting' && room.registrationDeadline && Number(room.registrationDeadline) <= Date.now()) {
          started = await startRoom(db, room);
          if (!started) room = await cancelExpiredWaitingRoom(db, room);
        }
        if (room.status === 'playing' && room.nextDrawAt && room.nextDrawAt <= Date.now()) {
          const advanced = advanceRoom(room);
          if (advanced.changed) await saveRoom(db, room, advanced.awards);
          else if (started) await saveRoom(db, room);
        } else if (started) await saveRoom(db, room);
      }).catch(error => { if (!(error instanceof HttpError && error.status === 409)) throw error; });
      room = await loadRoom(db, roomId);
    }
    return json({ok:true,room:await publicRoom(db,room,userId)});
  }

  if (request.method === 'POST' && action === 'join') {
    validateWriteOrigin(request);
    const body = await readJson(request);
    const requested = Math.max(1,Math.min(MAX_CARDS_PER_PLAYER,Math.floor(Number(body.cardsCount)||1)));
    const result = await withRoomLock(db,roomId,async()=>{
      let room = await loadRoom(db,roomId);
      const economics = ROOM_ECONOMICS[roomId];
      if (!economics) throw new HttpError(500,'تنظیمات مالی این اتاق پیدا نشد.');
      if (room.status === 'waiting' && room.registrationDeadline && Number(room.registrationDeadline) <= Date.now()) {
        const started = await startRoom(db,room);
        if (started) await saveRoom(db,room);
        else room = await cancelExpiredWaitingRoom(db, room);
      }
      if (room.status === 'playing') return {conflict:true,room:await publicRoom(db,room,userId)};
      if (room.status === 'finished') room = newRoom(roomId);
      const key = String(userId);
      const alreadyQueued = room.queue.some(id=>Number(id)===userId);
      const owned = alreadyQueued ? Math.max(0,Number(room.cardCounts?.[key])||room.queuedCards?.[key]?.length||0) : 0;
      const available = Math.max(0,MAX_CARDS_PER_PLAYER-owned);
      if (!available) throw new HttpError(409,'هر حساب در هر سانس حداکثر ۵ کارت می‌تواند بخرد.');
      const cardsCount = Math.min(requested,available);
      const totalPrice = economics.price * cardsCount;
      const debit = await db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?').bind(totalPrice,userId,totalPrice).run();
      if (!Number(debit.meta?.changes||0)) throw new HttpError(400,'موجودی کیف پول برای خرید تعداد کارت ثبت‌شده کافی نیست.');
      const oldCards = Array.isArray(room.queuedCards?.[key]) ? room.queuedCards[key] : [];
      room.cardCounts[key] = owned + cardsCount;
      room.queuedCards[key] = [...oldCards,...Array.from({length:cardsCount},()=>makeCard())];
      room.queuedNames[key] = String(user.username || 'بازیکن');
      room.entryPayments[key] = (Math.max(0,Number(room.entryPayments?.[key])||0))+totalPrice;
      if (!alreadyQueued) room.queue.push(userId);
      if (!room.registrationDeadline) {
        room.registrationStartedAt = Date.now();
        room.registrationDeadline = room.registrationStartedAt + REGISTRATION_WINDOW_MS;
      }
      room.updatedAt = Date.now();
      try {
        await db.batch([
          db.prepare(`INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?, 'room_entry', ?, ?, ?)`)
            .bind(userId,-totalPrice,alreadyQueued ? `خرید ${cardsCount} کارت اضافی دبرنا` : `خرید ${cardsCount} کارت دبرنا`,new Date().toISOString()),
          db.prepare(`INSERT INTO room_states (room_id,payload,updated_at) VALUES (?,?,?)
            ON CONFLICT(room_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
            .bind(room.id,JSON.stringify(room),room.updatedAt),
        ]);
      } catch(error) {
        await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(totalPrice,userId).run();
        throw error;
      }
      return {room:await publicRoom(db,room,userId)};
    });
    if (result.conflict) return json({error:'این سانس در حال اجراست؛ بعد از پایان وارد سانس بعدی شو.',room:result.room},409);
    return json({ok:true,room:result.room});
  }
  if (request.method === 'POST' && action === 'leave') {
    validateWriteOrigin(request);
    throw new HttpError(409,'پس از خرید کارت، امکان لغو خرید یا خروج از صف وجود ندارد.');
  }
  return json({error:'روش درخواست برای این مسیر پشتیبانی نمی‌شود.'},405);
}

async function referralSummary(db, userId) {
  const countRow = await db.prepare('SELECT COUNT(*) AS n FROM referrals WHERE inviter_id = ?').bind(userId).first();
  const count = Number(countRow?.n || 0);
  return { count, nextRewardIn: 5 - (count % 5), referralCode: (await db.prepare('SELECT referral_code FROM users WHERE id = ?').bind(userId).first())?.referral_code || '' };
}

async function recentWinners(db, limit = 12) {
  const result = await db.prepare(`SELECT room_id, round_id, total_players, total_cards, line_prize_paid, full_prize_paid,
    line_winners_json, full_winners_json, finished_at
    FROM room_finances ORDER BY id DESC LIMIT ?`).bind(limit).all();
  return (result.results || []).map((row) => {
    const parse = (value) => { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; } };
    return { ...row, lineWinners: parse(row.line_winners_json), fullWinners: parse(row.full_winners_json), finishedAt: row.finished_at };
  });
}

const GAME_RPS_CHOICES = ['rock','paper','scissors'];
const GAME_RPS_BEATS = { rock:'scissors', paper:'rock', scissors:'paper' };
const GAME_TIC_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function gameTicWinner(board) {
  for (const [a,b,c] of GAME_TIC_LINES) if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  return null;
}
function gameTicBotMove(board) {
  const winningMove = (mark) => {
    for (let i=0;i<9;i++) if (!board[i]) {
      board[i]=mark; const wins=gameTicWinner(board)===mark; board[i]='';
      if(wins) return i;
    }
    return -1;
  };
  const win=winningMove('O'); if(win!==-1) return win;
  const block=winningMove('X'); if(block!==-1 && randomInt(100)<82) return block;
  const available=board.map((v,i)=>v?-1:i).filter(i=>i!==-1);
  if(!available.length) return -1;
  const preferred=available.filter(i=>[0,2,4,6,8].includes(i));
  const pool=preferred.length&&randomInt(100)<68?preferred:available;
  return pool[randomInt(pool.length)];
}
function gameRpsBotChoice(history) {
  if(!history.length) return GAME_RPS_CHOICES[randomInt(3)];
  const predicted={rock:1.25,paper:1.25,scissors:1.25};
  history.forEach((choice,index)=>{predicted[choice]+=Math.pow(0.965,history.length-1-index);});
  const last=history[history.length-1];
  for(let i=0;i<history.length-1;i++) if(history[i]===last) predicted[history[i+1]]+=1.8*Math.pow(0.975,history.length-2-i);
  if(history.length>=2){const previous=history[history.length-2];for(let i=0;i<history.length-2;i++) if(history[i]===previous&&history[i+1]===last) predicted[history[i+2]]+=2.6*Math.pow(0.98,history.length-3-i);}
  if(randomInt(100)<32) return GAME_RPS_CHOICES[randomInt(3)];
  const total=GAME_RPS_CHOICES.reduce((sum,c)=>sum+predicted[c],0), expected={};
  for(const computer of GAME_RPS_CHOICES) expected[computer]=GAME_RPS_CHOICES.reduce((score,player)=>{
    const probability=predicted[player]/total;
    if(GAME_RPS_BEATS[computer]===player) return score+probability;
    if(GAME_RPS_BEATS[player]===computer) return score-probability;
    return score;
  },0);
  const best=Math.max(...Object.values(expected));
  const replies=GAME_RPS_CHOICES.filter(choice=>Math.abs(expected[choice]-best)<1e-9);
  return replies[randomInt(replies.length)];
}
function publicGameSession(row,state) { return {id:row.id,gameType:row.game_type,...state}; }
async function advanceServerGame(db,user,request,path) {
  if(!path.startsWith('/api/games/')) return null;
  if(request.method==='POST'&&path==='/api/games/start'){
    validateWriteOrigin(request);
    const body=await readJson(request), gameType=String(body.gameType||'');
    if(!['rps','tic'].includes(gameType)) throw new HttpError(400,'نوع بازی معتبر نیست.');
    const active=await db.prepare("SELECT id FROM game_sessions WHERE user_id=? AND game_type=? AND status='playing' ORDER BY created_at DESC LIMIT 1").bind(user.id,gameType).first();
    if(active) throw new HttpError(409,'یک مسابقه فعال از این نوع داری؛ آن را ادامه بده.',{matchId:active.id});
    const id=randomToken(16), now=new Date().toISOString();
    const state=gameType==='rps'?{round:1,player:0,bot:0,draws:0,history:[],rounds:[],finished:false,result:null}:{board:Array(9).fill(''),moves:0,finished:false,result:null};
    await db.prepare("INSERT INTO game_sessions (id,user_id,game_type,state_json,status,created_at,updated_at) VALUES (?,?,?,?,'playing',?,?)").bind(id,user.id,gameType,JSON.stringify(state),now,now).run();
    return json({ok:true,match:publicGameSession({id,game_type:gameType},state)});
  }
  if(request.method==='GET'&&path==='/api/games/active'){
    const gameType=new URL(request.url).searchParams.get('gameType');
    if(!['rps','tic'].includes(gameType||'')) throw new HttpError(400,'نوع بازی معتبر نیست.');
    const row=await db.prepare("SELECT id,game_type,state_json FROM game_sessions WHERE user_id=? AND game_type=? AND status='playing' ORDER BY created_at DESC LIMIT 1").bind(user.id,gameType).first();
    return json({ok:true,match:row?publicGameSession(row,JSON.parse(row.state_json)):null});
  }
  if(request.method==='POST'&&path==='/api/games/move'){
    validateWriteOrigin(request);
    const body=await readJson(request), matchId=String(body.matchId||'');
    if(!/^[0-9a-f]{32}$/i.test(matchId)) throw new HttpError(400,'شناسه مسابقه معتبر نیست.');
    const row=await db.prepare("SELECT id,game_type,state_json,status FROM game_sessions WHERE id=? AND user_id=? LIMIT 1").bind(matchId,user.id).first();
    if(!row) throw new HttpError(404,'مسابقه پیدا نشد.');
    if(row.status!=='playing') throw new HttpError(409,'این مسابقه قبلاً به پایان رسیده است.');
    let state; try{state=JSON.parse(row.state_json);}catch(_){throw new HttpError(500,'وضعیت مسابقه قابل خواندن نیست.');}
    let lastRound=null, finalResult=null;
    if(row.game_type==='rps'){
      const choice=String(body.choice||'');
      if(!GAME_RPS_CHOICES.includes(choice)) throw new HttpError(400,'انتخاب سنگ، کاغذ یا قیچی معتبر نیست.');
      const computer=gameRpsBotChoice(state.history||[]);
      const outcome=choice===computer?'draw':GAME_RPS_BEATS[choice]===computer?'win':'lose';
      if(outcome==='win') state.player++; else if(outcome==='lose') state.bot++; else state.draws++;
      const round=Number(state.round)||1;
      lastRound={player:choice,bot:computer,outcome,round,text:outcome==='win'?'این دور را بردی؛ یک امتیاز گرفتی.':outcome==='lose'?'این دور را رایانه برد؛ یک امتیاز گرفت.':'مساوی؛ این دور امتیازی نداشت.'};
      state.history=[...(state.history||[]),choice].slice(-120); state.rounds=[...(state.rounds||[]),{player:choice,bot:computer,outcome}];
      if(state.player>=3||state.bot>=3){state.finished=true;state.result=state.player===3?'win':'lose';finalResult=state.result;} else state.round=round+1;
    }else if(row.game_type==='tic'){
      const index=Number(body.index);
      if(!Number.isInteger(index)||index<0||index>8||state.board[index]) throw new HttpError(400,'خانه انتخاب‌شده معتبر یا خالی نیست.');
      state.board[index]='X';state.moves++;
      if(gameTicWinner(state.board)==='X'){state.finished=true;state.result='win';finalResult='win';}
      else if(state.board.every(Boolean)){state.finished=true;state.result='draw';finalResult='draw';}
      else{
        const botIndex=gameTicBotMove(state.board); if(botIndex>=0){state.board[botIndex]='O';state.moves++;}
        if(gameTicWinner(state.board)==='O'){state.finished=true;state.result='lose';finalResult='lose';}
        else if(state.board.every(Boolean)){state.finished=true;state.result='draw';finalResult='draw';}
      }
    }else throw new HttpError(400,'نوع مسابقه پشتیبانی نمی‌شود.');
    const now=new Date().toISOString(), nextStatus=state.finished?'finished':'playing';
    const statements=[db.prepare("UPDATE game_sessions SET state_json=?,status=?,updated_at=? WHERE id=? AND user_id=? AND status='playing' AND state_json=?").bind(JSON.stringify(state),nextStatus,now,matchId,user.id,row.state_json)];
    if(finalResult){
      statements.push(db.prepare("INSERT INTO game_results (user_id,game_type,result,prize,bingo_coins_earned,created_at) SELECT user_id,game_type,?,0,0,? FROM game_sessions WHERE id=? AND status='finished' AND updated_at=?").bind(finalResult,now,matchId,now));
      statements.push(db.prepare(`UPDATE users SET games_played=games_played+1,wins=wins+CASE WHEN ?='win' THEN 1 ELSE 0 END,points=points+CASE WHEN ?='win' THEN 10 ELSE 0 END WHERE id=(SELECT user_id FROM game_sessions WHERE id=? AND status='finished' AND updated_at=?)`).bind(finalResult,finalResult,matchId,now));
    }
    const batch=await db.batch(statements);
    if(!Number(batch[0]?.meta?.changes||0)) throw new HttpError(409,'حرکت هم‌زمان دیگری ثبت شده است؛ وضعیت مسابقه را دوباره دریافت کن.');
    const updatedUser=finalResult?await publicUser(db,await db.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first()):null;
    return json({ok:true,match:publicGameSession(row,state),lastRound,user:updatedUser});
  }
  return null;
}


async function ensureRecurringTournamentTables(db) {
  const sqls = [
    "CREATE TABLE IF NOT EXISTS tournament_events (id TEXT PRIMARY KEY, tournament_type TEXT NOT NULL, scheduled_at TEXT NOT NULL, registration_opens_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', registered_count INTEGER NOT NULL DEFAULT 0, capacity INTEGER NOT NULL DEFAULT 30, prize_pool INTEGER NOT NULL DEFAULT 0, min_players INTEGER NOT NULL DEFAULT 5, stage TEXT NOT NULL DEFAULT 'registration', stages_json TEXT NOT NULL DEFAULT '[]', stage_round INTEGER NOT NULL DEFAULT 1, stage_rounds INTEGER NOT NULL DEFAULT 1, current_round_id TEXT, started_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT, UNIQUE(tournament_type, scheduled_at))",
    "CREATE INDEX IF NOT EXISTS idx_tournament_events_schedule ON tournament_events(tournament_type, scheduled_at)",
    "CREATE INDEX IF NOT EXISTS idx_tournament_events_status ON tournament_events(status, scheduled_at)",
    "CREATE TABLE IF NOT EXISTS tournament_event_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, user_id INTEGER NOT NULL, entry_cost INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'registered', total_points INTEGER NOT NULL DEFAULT 0, line_wins INTEGER NOT NULL DEFAULT 0, full_wins INTEGER NOT NULL DEFAULT 0, rounds_played INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(event_id, user_id))",
    "CREATE INDEX IF NOT EXISTS idx_tournament_event_entries_event ON tournament_event_entries(event_id, status, total_points DESC)",
    "CREATE TABLE IF NOT EXISTS tournament_rounds (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, stage TEXT NOT NULL, round_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'playing', called_numbers_json TEXT NOT NULL DEFAULT '[]', line_winner_ids_json TEXT NOT NULL DEFAULT '[]', full_winner_ids_json TEXT NOT NULL DEFAULT '[]', next_draw_at INTEGER, started_at INTEGER NOT NULL, finished_at TEXT, UNIQUE(event_id, stage, round_number))",
    "CREATE INDEX IF NOT EXISTS idx_tournament_rounds_event ON tournament_rounds(event_id, started_at)",
    "CREATE TABLE IF NOT EXISTS tournament_round_players (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, round_id TEXT NOT NULL, user_id INTEGER NOT NULL, card_json TEXT NOT NULL, matched_count INTEGER NOT NULL DEFAULT 0, line_hit INTEGER NOT NULL DEFAULT 0, full_hit INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0, scored_at TEXT, UNIQUE(round_id, user_id))",
    "CREATE INDEX IF NOT EXISTS idx_tournament_round_players_round ON tournament_round_players(round_id, user_id)",
    "CREATE TABLE IF NOT EXISTS tournament_prize_payouts (event_id TEXT NOT NULL, user_id INTEGER NOT NULL, rank INTEGER NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(event_id, user_id), UNIQUE(event_id, rank))"
  ];
  for (const sql of sqls) await db.prepare(sql).run();

  const migrations = [
    ["tournament_events", "capacity", "INTEGER NOT NULL DEFAULT 30"],
    ["tournament_events", "stage_round", "INTEGER NOT NULL DEFAULT 1"],
    ["tournament_events", "stage_rounds", "INTEGER NOT NULL DEFAULT 1"],
    ["tournament_events", "current_round_id", "TEXT"],
    ["tournament_events", "started_at", "TEXT"],
    ["tournament_event_entries", "rounds_played", "INTEGER NOT NULL DEFAULT 0"]
  ];
  for (const item of migrations) {
    const info = await db.prepare("PRAGMA table_info(" + item[0] + ")").all();
    const columns = new Set((info.results || []).map((row) => row.name));
    if (!columns.has(item[1])) {
      try {
        await db.prepare("ALTER TABLE " + item[0] + " ADD COLUMN " + item[1] + " " + item[2]).run();
      } catch (error) {
        if (!String(error && error.message || error).toLowerCase().includes("duplicate column")) throw error;
      }
    }
  }
}

function tournamentCost(type) {
  return type === "simple" ? 20 : type === "bingo" ? 100 : 0;
}
function tournamentTitle(type) {
  return type === "simple" ? "تورنومنت ساده هفتگی" : "تورنومنت VIP ماهانه";
}
function tournamentId(type, startMs) {
  return type + "-" + new Date(startMs).toISOString().replace(/[^0-9]/g, "").slice(0, 12);
}
function parseTournamentArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}
function tournamentStageLabel(stage) {
  const labels = {
    registration: "ثبت‌نام",
    qualifying: "مرحله مقدماتی",
    quarterfinal: "یک‌چهارم نهایی",
    semifinal: "نیمه‌نهایی",
    final: "فینال",
    completed: "پایان‌یافته",
    cancelled: "لغوشده"
  };
  return labels[stage] || "در انتظار شروع";
}

async function ensureRecurringTournamentSchedule(db, nowMs) {
  const current = Number.isFinite(nowMs) ? nowMs : Date.now();
  await ensureRecurringTournamentTables(db);
  for (const type of ["simple", "bingo"]) {
    const startMs = nextTournamentStartAt(type, current);
    const scheduledAt = new Date(startMs).toISOString();
    const opensAt = new Date(startMs - 7 * 86400000).toISOString();
    const nowText = new Date(current).toISOString();
    await db.prepare("INSERT OR IGNORE INTO tournament_events (id,tournament_type,scheduled_at,registration_opens_at,status,registered_count,prize_pool,min_players,stage,stages_json,stage_round,stage_rounds,created_at,updated_at) VALUES (?,?,?,?, 'scheduled',0,0,5,'registration','[]',1,1,?,?)")
      .bind(tournamentId(type, startMs), type, scheduledAt, opensAt, nowText, nowText).run();
  }
  const nowText = new Date(current).toISOString();
  await db.prepare("UPDATE tournament_events SET status='registration',stage='registration',updated_at=? WHERE status='scheduled' AND registration_opens_at<=? AND scheduled_at>?")
    .bind(nowText, nowText, nowText).run();
}

async function refundTournamentEvent(db, event, nowMs) {
  const nowText = new Date(nowMs || Date.now()).toISOString();
  const entries = await db.prepare("SELECT user_id,entry_cost FROM tournament_event_entries WHERE event_id=? AND status='registered' ORDER BY id")
    .bind(event.id).all();
  const rows = entries.results || [];
  for (let offset = 0; offset < rows.length; offset += 30) {
    const statements = [];
    for (const row of rows.slice(offset, offset + 30)) {
      statements.push(
        db.prepare("UPDATE tournament_event_entries SET status='refunded' WHERE event_id=? AND user_id=? AND status='registered'")
          .bind(event.id, row.user_id),
        db.prepare("UPDATE users SET bingo_coins=bingo_coins+? WHERE id=? AND changes()=1")
          .bind(row.entry_cost, row.user_id),
        db.prepare("INSERT INTO transactions (user_id,type,amount,description,created_at) SELECT ?,'bingo_coin',?,?,? WHERE changes()=1")
          .bind(row.user_id, row.entry_cost, "بازگشت ورودی " + tournamentTitle(event.tournament_type), nowText)
      );
    }
    if (statements.length) await db.batch(statements);
  }
}

async function createTournamentRound(db, event, stage, roundNumber, nowMs) {
  const roundId = event.id + "-" + stage + "-" + String(roundNumber);
  const startedAt = Number(nowMs || Date.now());
  const participants = await db.prepare("SELECT user_id FROM tournament_event_entries WHERE event_id=? AND status IN ('registered','qualified') ORDER BY created_at,user_id")
    .bind(event.id).all();
  const players = participants.results || [];
  if (!players.length) return null;

  await db.prepare("INSERT OR IGNORE INTO tournament_rounds (id,event_id,stage,round_number,status,called_numbers_json,line_winner_ids_json,full_winner_ids_json,next_draw_at,started_at) VALUES (?,?,?,?,'playing','[]','[]','[]',?,?)")
    .bind(roundId, event.id, stage, roundNumber, startedAt + 3000, startedAt).run();

  for (let offset = 0; offset < players.length; offset += 40) {
    const statements = players.slice(offset, offset + 40).map((player) => {
      const card = makeTournamentCard(randomInt);
      return db.prepare("INSERT OR IGNORE INTO tournament_round_players (id,event_id,round_id,user_id,card_json) VALUES (?,?,?,?,?)")
        .bind(roundId + "-" + String(player.user_id), event.id, roundId, player.user_id, JSON.stringify(card));
    });
    if (statements.length) await db.batch(statements);
  }
  await db.prepare("UPDATE tournament_events SET current_round_id=?,updated_at=? WHERE id=? AND current_round_id IS NULL AND status='running'")
    .bind(roundId, new Date(startedAt).toISOString(), event.id).run();
  return await db.prepare("SELECT * FROM tournament_rounds WHERE id=?").bind(roundId).first();
}

async function scoreTournamentRound(db, eventId, round, tournamentType) {
  if (!round || round.status !== "finished") return;
  const result = await db.prepare("SELECT id,user_id,card_json FROM tournament_round_players WHERE round_id=? ORDER BY user_id")
    .bind(round.id).all();
  const players = result.results || [];
  const scores = scoreTournamentPlayers(players, parseTournamentArray(round.called_numbers_json), tournamentType);
  const byUser = new Map(scores.map((item) => [String(item.userId), item]));
  const nowText = new Date().toISOString();

  for (let offset = 0; offset < players.length; offset += 30) {
    const statements = [];
    for (const player of players.slice(offset, offset + 30)) {
      const score = byUser.get(String(player.user_id));
      if (!score) continue;
      statements.push(
        db.prepare("UPDATE tournament_round_players SET matched_count=?,line_hit=?,full_hit=?,score=?,scored_at=? WHERE id=? AND scored_at IS NULL")
          .bind(score.matchedCount, score.lineHit ? 1 : 0, score.fullHit ? 1 : 0, score.score, nowText, player.id),
        db.prepare("UPDATE tournament_event_entries SET total_points=total_points+?,line_wins=line_wins+?,full_wins=full_wins+?,rounds_played=rounds_played+1 WHERE event_id=? AND user_id=? AND changes()=1")
          .bind(score.score, score.lineHit ? 1 : 0, score.fullHit ? 1 : 0, eventId, player.user_id)
      );
    }
    if (statements.length) await db.batch(statements);
  }
}

async function advanceTournamentRound(db, round, nowMs) {
  const current = round;
  const now = Number(nowMs || Date.now());
  if (!current || current.status !== "playing" || Number(current.next_draw_at) > now) return current;

  const called = parseTournamentArray(current.called_numbers_json);
  const calledSet = new Set(called);
  const remaining = Array.from({ length: 90 }, (_, index) => index + 1).filter((number) => !calledSet.has(number));
  const playerResult = await db.prepare("SELECT user_id,card_json FROM tournament_round_players WHERE round_id=? ORDER BY user_id")
    .bind(current.id).all();
  const playerRows = playerResult.results || [];
  const number = remaining.length ? remaining[randomInt(remaining.length)] : null;
  const nextCalled = number === null ? called : [...called, number];
  const nextSet = new Set(nextCalled);
  const lineWinners = parseTournamentArray(current.line_winner_ids_json);
  const fullWinners = parseTournamentArray(current.full_winner_ids_json);

  if (!lineWinners.length) {
    for (const player of playerRows) {
      const card = JSON.parse(player.card_json);
      const hasLine = card.some((row) => {
        const values = row.filter(Number.isInteger);
        return values.length === 5 && values.every((value) => nextSet.has(value));
      });
      if (hasLine) lineWinners.push(Number(player.user_id));
    }
  }
  if (!fullWinners.length) {
    for (const player of playerRows) {
      const card = JSON.parse(player.card_json);
      const values = card.flat().filter(Number.isInteger);
      if (values.length === 15 && values.every((value) => nextSet.has(value))) fullWinners.push(Number(player.user_id));
    }
  }

  const finished = fullWinners.length > 0 || nextCalled.length >= 90;
  const nextDrawAt = finished ? null : now + 3000;
  const update = await db.prepare("UPDATE tournament_rounds SET called_numbers_json=?,line_winner_ids_json=?,full_winner_ids_json=?,next_draw_at=?,status=?,finished_at=? WHERE id=? AND status='playing' AND next_draw_at=? AND next_draw_at<=?")
    .bind(JSON.stringify(nextCalled), JSON.stringify(lineWinners), JSON.stringify(fullWinners), nextDrawAt,
      finished ? "finished" : "playing", finished ? new Date(now).toISOString() : null, current.id, current.next_draw_at, now).run();
  if (!Number(update.meta && update.meta.changes || 0)) {
    return await db.prepare("SELECT * FROM tournament_rounds WHERE id=?").bind(current.id).first();
  }
  return await db.prepare("SELECT * FROM tournament_rounds WHERE id=?").bind(current.id).first();
}

async function tournamentRankings(db, eventId) {
  const result = await db.prepare("SELECT user_id,total_points,line_wins,full_wins,rounds_played,created_at FROM tournament_event_entries WHERE event_id=? AND status IN ('registered','qualified') ORDER BY total_points DESC,full_wins DESC,line_wins DESC,rounds_played DESC,created_at ASC,user_id ASC")
    .bind(eventId).all();
  return result.results || [];
}

async function payTournamentPrizes(db, event) {
  const rankings = await tournamentRankings(db, event.id);
  if (!rankings.length) return;
  const shares = event.tournament_type === "simple" ? [60, 25, 15] : [50, 30, 20];
  const pool = Math.max(0, Number(event.prize_pool) || 0);
  const amounts = shares.map((share) => Math.floor(pool * share / 100));
  amounts[0] += pool - amounts.reduce((sum, value) => sum + value, 0);
  const nowText = new Date().toISOString();
  const statements = [
    db.prepare("UPDATE tournament_events SET status='settling',updated_at=? WHERE id=? AND status='running' AND stage='final'")
      .bind(nowText, event.id)
  ];
  rankings.slice(0, 3).forEach((player, index) => {
    const amount = amounts[index] || 0;
    statements.push(
      db.prepare("INSERT OR IGNORE INTO tournament_prize_payouts (event_id,user_id,rank,amount,created_at) VALUES (?,?,?,?,?)")
        .bind(event.id, player.user_id, index + 1, amount, nowText),
      db.prepare("UPDATE users SET bingo_coins=bingo_coins+? WHERE id=? AND changes()=1")
        .bind(amount, player.user_id),
      db.prepare("INSERT INTO transactions (user_id,type,amount,description,created_at) SELECT ?,'bingo_coin',?,?,? WHERE changes()=1")
        .bind(player.user_id, amount, "جایزه رتبه " + String(index + 1) + " تورنومنت دابرناز", nowText),
      db.prepare("UPDATE tournament_event_entries SET status=? WHERE event_id=? AND user_id=? AND EXISTS (SELECT 1 FROM tournament_prize_payouts WHERE event_id=? AND user_id=?)")
        .bind("winner_" + String(index + 1), event.id, player.user_id, event.id, player.user_id)
    );
  });
  statements.push(db.prepare("UPDATE tournament_events SET status='completed',stage='completed',finished_at=?,updated_at=? WHERE id=? AND status IN ('settling','running')")
    .bind(nowText, nowText, event.id));
  await db.batch(statements);
}

async function advanceTournamentStage(db, event, round) {
  const stages = parseTournamentArray(event.stages_json);
  const stageIndex = stages.findIndex((item) => item.key === event.stage);
  if (stageIndex < 0) return;
  const currentStage = stages[stageIndex];
  const roundNumber = Number(round.round_number) || 1;
  const nowText = new Date().toISOString();

  if (roundNumber < Number(currentStage.rounds || 1)) {
    const update = await db.prepare("UPDATE tournament_events SET stage_round=?,current_round_id=NULL,updated_at=? WHERE id=? AND status='running' AND stage=? AND stage_round=? AND current_round_id=?")
      .bind(roundNumber + 1, nowText, event.id, event.stage, roundNumber, round.id).run();
    if (Number(update.meta && update.meta.changes || 0)) {
      const fresh = await db.prepare("SELECT * FROM tournament_events WHERE id=?").bind(event.id).first();
      await createTournamentRound(db, fresh, fresh.stage, Number(fresh.stage_round), Date.now());
    }
    return;
  }

  const nextStage = stages[stageIndex + 1];
  if (nextStage) {
    const rankings = await tournamentRankings(db, event.id);
    const selected = rankings.slice(0, Math.max(1, Number(currentStage.advance) || 8));
    const statements = [
      db.prepare("UPDATE tournament_events SET status='running',stage=?,stage_round=1,stage_rounds=?,current_round_id=NULL,updated_at=? WHERE id=? AND status='running' AND stage=? AND stage_round=? AND current_round_id=?")
        .bind(nextStage.key, nextStage.rounds, nowText, event.id, event.stage, roundNumber, round.id),
      db.prepare("UPDATE tournament_event_entries SET status='eliminated' WHERE event_id=? AND status IN ('registered','qualified') AND changes()=1")
        .bind(event.id)
    ];
    for (const player of selected) {
      statements.push(db.prepare("UPDATE tournament_event_entries SET status='qualified' WHERE event_id=? AND user_id=? AND status='eliminated'")
        .bind(event.id, player.user_id));
    }
    const result = await db.batch(statements);
    if (Number(result[0] && result[0].meta && result[0].meta.changes || 0)) {
      const fresh = await db.prepare("SELECT * FROM tournament_events WHERE id=?").bind(event.id).first();
      await createTournamentRound(db, fresh, fresh.stage, 1, Date.now());
    }
    return;
  }

  await payTournamentPrizes(db, event);
}

async function startOrCancelDueTournament(db, event, nowMs) {
  const nowText = new Date(nowMs).toISOString();
  const totals = await db.prepare("SELECT COUNT(*) AS player_count,COALESCE(SUM(entry_cost),0) AS prize_pool FROM tournament_event_entries WHERE event_id=? AND status='registered'")
    .bind(event.id).first();
  const playerCount = Number(totals && totals.player_count || 0);
  const pool = Number(totals && totals.prize_pool || 0);
  if (playerCount < Number(event.min_players || 5)) {
    const update = await db.prepare("UPDATE tournament_events SET status='cancelled',stage='cancelled',registered_count=?,prize_pool=?,finished_at=?,updated_at=? WHERE id=? AND status IN ('scheduled','registration')")
      .bind(playerCount, pool, nowText, nowText, event.id).run();
    if (Number(update.meta && update.meta.changes || 0) || event.status === "cancelled") {
      await refundTournamentEvent(db, event, nowMs);
    }
    return;
  }
  const stages = buildTournamentStages(event.tournament_type, playerCount);
  const first = stages[0];
  const update = await db.prepare("UPDATE tournament_events SET status='running',stage=?,stage_round=1,stage_rounds=?,current_round_id=NULL,registered_count=?,prize_pool=?,stages_json=?,started_at=?,updated_at=? WHERE id=? AND status IN ('scheduled','registration')")
    .bind(first.key, first.rounds, playerCount, pool, JSON.stringify(stages), nowText, nowText, event.id).run();
  if (Number(update.meta && update.meta.changes || 0)) {
    const fresh = await db.prepare("SELECT * FROM tournament_events WHERE id=?").bind(event.id).first();
    await createTournamentRound(db, fresh, fresh.stage, 1, nowMs);
  }
}

async function advanceTournamentEvent(db, event, nowMs, advanceDraws = true) {
  if (event.status === "cancelled") {
    await refundTournamentEvent(db, event, nowMs);
    return;
  }
  if (event.status === "completed") return;
  if (["scheduled", "registration"].includes(event.status) && Date.parse(event.scheduled_at) <= nowMs) {
    await startOrCancelDueTournament(db, event, nowMs);
    event = await db.prepare("SELECT * FROM tournament_events WHERE id=?").bind(event.id).first();
  }
  if (!event || event.status !== "running" || !advanceDraws) return;
  let round = event.current_round_id
    ? await db.prepare("SELECT * FROM tournament_rounds WHERE id=?").bind(event.current_round_id).first()
    : null;
  if (!round) {
    round = await createTournamentRound(db, event, event.stage, Number(event.stage_round) || 1, nowMs);
  }
  if (!round) return;
  if (round.status === "playing") round = await advanceTournamentRound(db, round, nowMs);
  if (round && round.status === "finished") {
    await scoreTournamentRound(db, event.id, round, event.tournament_type);
    const fresh = await db.prepare("SELECT * FROM tournament_events WHERE id=?").bind(event.id).first();
    if (fresh && fresh.status === "running" && fresh.current_round_id === round.id) {
      await advanceTournamentStage(db, fresh, round);
    }
  }
}

async function advanceTournamentSystem(db, nowMs, advanceDraws = true) {
  const current = Number(nowMs || Date.now());
  await ensureRecurringTournamentSchedule(db, current);
  const active = await db.prepare("SELECT * FROM tournament_events WHERE status IN ('scheduled','registration','running','cancelled') ORDER BY scheduled_at ASC LIMIT 12")
    .all();
  for (const event of active.results || []) {
    await advanceTournamentEvent(db, event, current, advanceDraws);
  }
  await ensureRecurringTournamentSchedule(db, current + 1000);
}

async function recurringTournamentSnapshots(db, advanceDraws = true) {
  await advanceTournamentSystem(db, Date.now(), advanceDraws);
  const rows = await db.prepare("SELECT * FROM tournament_events ORDER BY CASE WHEN status IN ('scheduled','registration','running') THEN 0 ELSE 1 END,scheduled_at ASC LIMIT 12").all();
  const output = [];
  for (const event of rows.results || []) {
    const round = event.current_round_id
      ? await db.prepare("SELECT * FROM tournament_rounds WHERE id=?").bind(event.current_round_id).first()
      : null;
    const leaders = await db.prepare("SELECT u.username,u.member_id,e.total_points,e.line_wins,e.full_wins,e.status FROM tournament_event_entries e JOIN users u ON u.id=e.user_id WHERE e.event_id=? AND e.status!='refunded' ORDER BY e.total_points DESC,e.full_wins DESC,e.line_wins DESC,e.rounds_played DESC,e.created_at ASC LIMIT 5")
      .bind(event.id).all();
    output.push({
      id: event.id,
      tournament_type: event.tournament_type,
      scheduled_at: event.scheduled_at,
      registration_opens_at: event.registration_opens_at,
      status: event.status,
      stage: event.stage,
      stage_label: tournamentStageLabel(event.stage),
      stage_round: Number(event.stage_round) || 0,
      stage_rounds: Number(event.stage_rounds) || 0,
      registered_count: Number(event.registered_count) || 0,
      capacity: Number(event.capacity) || 30,
      registration_full: Number(event.registered_count) >= Number(event.capacity || 30),
      min_players: Number(event.min_players) || 5,
      entry_cost: tournamentCost(event.tournament_type),
      prize_pool: Number(event.prize_pool) || 0,
      stages: parseTournamentArray(event.stages_json),
      current_round: round ? {
        id: round.id,
        stage: round.stage,
        round_number: Number(round.round_number) || 0,
        status: round.status,
        called_numbers: parseTournamentArray(round.called_numbers_json),
        latest_number: parseTournamentArray(round.called_numbers_json).slice(-1)[0] || null,
        line_winner_ids: parseTournamentArray(round.line_winner_ids_json),
        full_winner_ids: parseTournamentArray(round.full_winner_ids_json)
      } : null,
      top_players: (leaders.results || []).map((player) => ({
        name: player.username,
        memberId: player.member_id,
        points: Number(player.total_points) || 0,
        lineWins: Number(player.line_wins) || 0,
        fullWins: Number(player.full_wins) || 0,
        status: player.status
      }))
    });
  }
  return output;
}

async function publicTournamentSnapshots(db) {
  const detailed = await recurringTournamentSnapshots(db, false);
  const rooms = [];
  for (const type of ["simple", "bingo"]) {
    const selected = detailed.find((event) => event.tournament_type === type &&
      ["scheduled", "registration", "running"].includes(event.status)) ||
      detailed.find((event) => event.tournament_type === type);
    if (!selected) continue;
    rooms.push({
      id: selected.id,
      tournament_type: selected.tournament_type,
      scheduled_at: selected.scheduled_at,
      registration_opens_at: selected.registration_opens_at,
      status: selected.status,
      stage: selected.stage,
      stage_label: selected.stage_label,
      stage_round: selected.stage_round,
      stage_rounds: selected.stage_rounds,
      registered_count: selected.registered_count,
      capacity: selected.capacity,
      registration_full: selected.registration_full,
      min_players: selected.min_players,
      entry_cost: selected.entry_cost,
      prize_pool: selected.prize_pool
    });
  }
  return rooms;
}

async function registerRecurringTournament(db, user, request) {
  validateWriteOrigin(request);
  const body = await readJson(request);
  const type = String(body.type || "");
  const cost = tournamentCost(type);
  if (!cost) throw new HttpError(400, "نوع تورنومنت معتبر نیست.");
  await advanceTournamentSystem(db, Date.now(), false);
  const nowText = new Date().toISOString();
  const event = await db.prepare("SELECT * FROM tournament_events WHERE tournament_type=? AND status='registration' AND scheduled_at>? ORDER BY scheduled_at ASC LIMIT 1")
    .bind(type, nowText).first();
  if (!event) throw new HttpError(409, "ثبت‌نام این دوره در حال حاضر باز نیست.");

  const result = await db.batch([
    db.prepare("UPDATE tournament_events SET registered_count=registered_count+1,prize_pool=prize_pool+?,updated_at=? WHERE id=? AND status='registration' AND registered_count<capacity AND scheduled_at>? AND EXISTS (SELECT 1 FROM users WHERE id=? AND bingo_coins>=?) AND NOT EXISTS (SELECT 1 FROM tournament_event_entries WHERE event_id=? AND user_id=?)")
      .bind(cost, nowText, event.id, nowText, user.id, cost, event.id, user.id),
    db.prepare("UPDATE users SET bingo_coins=bingo_coins-? WHERE id=? AND changes()=1")
      .bind(cost, user.id),
    db.prepare("INSERT INTO tournament_event_entries (event_id,user_id,entry_cost,status,created_at) SELECT ?,?,?,'registered',? WHERE changes()=1")
      .bind(event.id, user.id, cost, nowText),
    db.prepare("INSERT INTO transactions (user_id,type,amount,description,created_at) SELECT ?,'bingo_coin',?,?,? WHERE changes()=1")
      .bind(user.id, -cost, "ورود به " + tournamentTitle(type), nowText)
  ]);

  if (!Number(result[0] && result[0].meta && result[0].meta.changes || 0)) {
    const existing = await db.prepare("SELECT id FROM tournament_event_entries WHERE event_id=? AND user_id=?").bind(event.id, user.id).first();
    if (existing) throw new HttpError(409, "برای این دوره قبلاً ثبت‌نام کرده‌ای.");
    const freshEvent = await db.prepare("SELECT registered_count,capacity FROM tournament_events WHERE id=?").bind(event.id).first();
    if (freshEvent && Number(freshEvent.registered_count) >= Number(freshEvent.capacity || 30)) {
      throw new HttpError(409, "ظرفیت ۳۰ نفرهٔ این دوره تکمیل شده است.");
    }
    const freshUser = await db.prepare("SELECT bingo_coins FROM users WHERE id=?").bind(user.id).first();
    if (Number(freshUser && freshUser.bingo_coins || 0) < cost) throw new HttpError(409, "بینگوکوین کافی برای ثبت‌نام نداری.");
    throw new HttpError(409, "مهلت ثبت‌نام این دوره به پایان رسیده است.");
  }
  const updated = await db.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first();
  return json({ ok: true, event_id: event.id, tournament: type, user: await publicUser(db, updated) });
}

async function myRecurringTournamentData(db, userId) {
  const events = await recurringTournamentSnapshots(db);
  const entries = await db.prepare("SELECT e.event_id,e.entry_cost,e.status,e.total_points,e.line_wins,e.full_wins,e.rounds_played,e.created_at,t.tournament_type,t.scheduled_at,t.status AS event_status,t.stage,t.prize_pool FROM tournament_event_entries e JOIN tournament_events t ON t.id=e.event_id WHERE e.user_id=? ORDER BY t.scheduled_at DESC LIMIT 30")
    .bind(userId).all();
  const ownedEntries = entries.results || [];
  for (const event of events) {
    const ownEntry = ownedEntries.find((entry) => entry.event_id === event.id &&
      ["registered", "qualified", "winner_1", "winner_2", "winner_3"].includes(entry.status));
    const roundId = event.current_round && event.current_round.id;
    if (!ownEntry || !roundId) continue;
    const player = await db.prepare("SELECT card_json,matched_count,line_hit,full_hit,score FROM tournament_round_players WHERE round_id=? AND user_id=?")
      .bind(roundId, userId).first();
    if (!player) continue;
    event.my_card = parseTournamentArray(player.card_json);
    const calledSet = new Set(event.current_round.called_numbers || []);
    const myNumbers = event.my_card.flat().filter(Number.isInteger);
    event.my_matched_count = myNumbers.filter((number) => calledSet.has(number)).length;
    event.my_round_score = Number(player.score) || 0;
    event.my_line_hit = event.my_card.some((row) => {
      const rowNumbers = row.filter(Number.isInteger);
      return rowNumbers.length === 5 && rowNumbers.every((number) => calledSet.has(number));
    });
    event.my_full_hit = myNumbers.length === 15 && myNumbers.every((number) => calledSet.has(number));
    event.my_entry_status = ownEntry.status;
    event.my_total_points = Number(ownEntry.total_points) || 0;
  }
  return { events, entries: ownedEntries, rooms: events };
}


let githubActionsJwksCache = null;
let githubActionsJwksLoadedAt = 0;

function decodeBase64UrlBytes(segment) {
  const normalized = String(segment || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBase64UrlJson(segment) {
  return JSON.parse(new TextDecoder().decode(decodeBase64UrlBytes(segment)));
}

async function githubActionsSigningKey(kid) {
  const now = Date.now();
  if (!githubActionsJwksCache || now - githubActionsJwksLoadedAt > 15 * 60 * 1000) {
    const response = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks", {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 900, cacheEverything: true }
    });
    if (!response.ok) throw new Error("GitHub Actions OIDC signing keys are temporarily unavailable.");
    const jwks = await response.json();
    if (!Array.isArray(jwks.keys)) throw new Error("GitHub Actions OIDC signing keys response is invalid.");
    githubActionsJwksCache = jwks.keys;
    githubActionsJwksLoadedAt = now;
  }
  const jwk = githubActionsJwksCache.find((item) => item.kid === kid && item.kty === "RSA" && item.use === "sig");
  if (!jwk) {
    githubActionsJwksCache = null;
    githubActionsJwksLoadedAt = 0;
    throw new Error("GitHub Actions OIDC signing key was not found.");
  }
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

async function verifyTournamentSchedulerRequest(request) {
  const authorization = request.headers.get("authorization") || "";
  if (!/^Bearer\s+/i.test(authorization)) return false;
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token || token.length > 8192) return false;
  const segments = token.split(".");
  if (segments.length !== 3) return false;

  let header;
  let claims;
  let signature;
  try {
    header = decodeBase64UrlJson(segments[0]);
    claims = decodeBase64UrlJson(segments[1]);
    signature = decodeBase64UrlBytes(segments[2]);
  } catch (_) {
    return false;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !signature.length) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expectedWorkflow = "nimamoshfegh8/dabernaz/.github/workflows/tournament-scheduler.yml@refs/heads/main";
  // GitHub now issues immutable subject claims for repositories created after
  // 2026-07-15. Accept that format and the legacy format, while independently
  // pinning both repository and owner IDs so this trust remains repo-specific.
  const expectedSubjects = new Set([
    "repo:nimamoshfegh8/dabernaz:ref:refs/heads/main",
    "repo:nimamoshfegh8@352508767/dabernaz@1445832866:ref:refs/heads/main"
  ]);
  if (
    claims.iss !== "https://token.actions.githubusercontent.com" ||
    !audience.includes("dabernaz-tournament-scheduler") ||
    claims.repository !== "nimamoshfegh8/dabernaz" ||
    String(claims.repository_id) !== "1445832866" ||
    String(claims.repository_owner_id) !== "352508767" ||
    claims.ref !== "refs/heads/main" ||
    !expectedSubjects.has(claims.sub) ||
    claims.workflow_ref !== expectedWorkflow ||
    !["schedule", "workflow_dispatch"].includes(claims.event_name) ||
    !Number.isFinite(Number(claims.exp)) ||
    Number(claims.exp) <= nowSeconds ||
    !Number.isFinite(Number(claims.nbf)) ||
    Number(claims.nbf) > nowSeconds + 60 ||
    !Number.isFinite(Number(claims.iat)) ||
    Number(claims.iat) > nowSeconds + 60
  ) {
    return false;
  }

  try {
    const key = await githubActionsSigningKey(header.kid);
    const message = encoder.encode(segments[0] + "." + segments[1]);
    return await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature,
      message
    );
  } catch (error) {
    console.error("[dabernaz-tournament-oidc]", String(error && error.message || error));
    return false;
  }
}

async function routeRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return json({ error: 'مسیر API پیدا نشد.' }, 404);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'allow': 'GET, POST, PATCH, OPTIONS',
    'cache-control': 'no-store',
  } });

  // Keep a lightweight health probe independent from schema initialization so the
  // frontend can distinguish "API route is alive" from a D1/migration failure.
  if (request.method === 'GET' && path === '/api/health') {
    if (!env.DB) return json({ ok: false, service: 'dabernaz', backend: 'cloudflare-pages-functions', database: 'missing', binding: 'missing', mode: 'misconfigured' }, 503);
    try {
      const row = await env.DB.prepare('SELECT 1 AS ok').first();
      if (Number(row?.ok) !== 1) throw new Error('D1 health query returned an unexpected result.');
      return json({ ok: true, service: 'dabernaz', backend: 'cloudflare-pages-functions', database: 'D1', binding: 'bound', mode: 'ready' });
    } catch (_) {
      return json({ ok: false, service: 'dabernaz', backend: 'cloudflare-pages-functions', database: 'unreachable', binding: 'bound', mode: 'degraded' }, 503);
    }
  }

  // This endpoint reports the voice package contract only. It must never
  // claim that the files are ready: the client validates and decodes all 90 clips.
  if (request.method === 'GET' && path === '/api/voice/health') {
    return json({
      ok: true,
      ready: null,
      verifiedBy: 'client-audio-manager',
      status: 'client-validation-required',
      provider: 'kenerate-sage-woman',
      voice: 'Sage Woman',
      language: 'fa-IR',
      requiredNumbers: 90,
      asset: '/assets/voice/sage-woman.mp3',
      manifest: '/assets/voice/sage-woman.json',
      note: 'Endpoint availability is not audio-package readiness. The client must fetch, decode and validate the MP3 and all 90 clips.'
    });
  }

  if (!env.DB) return json({ ok: false, error: 'اتصال D1 تنظیم نشده است؛ در Pages Settings یک D1 binding با نام DB اضافه کن.' }, 503);
  await ensureSchema(env.DB);

  if (request.method === 'GET' && path === '/api/rooms/history') {
    return json({ ok: true, rounds: await recentWinners(env.DB) });
  }

  if (request.method === 'POST' && path === '/api/tournaments/advance') {
    if (!await verifyTournamentSchedulerRequest(request)) {
      throw new HttpError(401, 'درخواست زمان‌بندی مسابقه معتبر نیست.');
    }
    await advanceTournamentSystem(env.DB, Date.now(), true);
    const rooms = await publicTournamentSnapshots(env.DB);
    return json({ ok: true, advanced: true, rooms });
  }

  if (request.method === 'GET' && path === '/api/tournaments') {
    const rooms = await publicTournamentSnapshots(env.DB);
    return json({ ok:true, rooms, events:rooms });
  }

  const authResponse = await handleAuth(env.DB, request, path);
  if (authResponse) return authResponse;

  const isProtected = path === '/api/profile' || path.startsWith('/api/games/') || /^\/api\/rooms\//.test(path) || path === '/api/referrals' || path === '/api/support' || path === '/api/tickets' || path === '/api/tournaments/me' || path === '/api/tournaments/register';
  if (!isProtected) return json({ error: 'مسیر API پیدا نشد.' }, 404);
  const user = await authenticatedUser(env.DB, request);
  if (!user) throw new HttpError(401, 'برای ادامه ابتدا وارد حساب کاربری شو.');

  if (request.method === 'PATCH' && path === '/api/profile') {
    validateWriteOrigin(request);
    const body = await readJson(request);
    const name = String(body.name || '').trim();
    const length = [...name].length;
    if (length < 2 || length > 32) throw new HttpError(400, 'نام نمایشی باید بین ۲ تا ۳۲ نویسه باشد.');
    try {
      await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(name, user.id).run();
    } catch (_) {
      throw new HttpError(409, 'این نام کاربری قبلاً استفاده شده است.');
    }
    const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    return json({ ok: true, user: await publicUser(env.DB, updated) });
  }

  if (request.method === 'GET' && path === '/api/referrals') {
    return json({ ok: true, ...(await referralSummary(env.DB, user.id)) });
  }

  if (request.method === 'POST' && path === '/api/support') {
    validateWriteOrigin(request);
    const body = await readJson(request);
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '').trim();
    if (subject.length < 3 || subject.length > 70 || message.length < 3 || message.length > 1000) throw new HttpError(400, 'موضوع یا متن پیام معتبر نیست.');
    const nowText = new Date().toISOString();
    const inserted = await env.DB.prepare('INSERT INTO support_tickets (user_id, subject, message, status, created_at) VALUES (?, ?, ?, \'open\', ?)')
      .bind(user.id, subject, message, nowText).run();
    return json({ ok: true, ticketId: Number(inserted.meta?.last_row_id || 0) });
  }

  if (request.method === 'GET' && path === '/api/tickets') {
    const result = await env.DB.prepare('SELECT id, subject, status, created_at FROM support_tickets WHERE user_id = ? ORDER BY id DESC LIMIT 20').bind(user.id).all();
    return json({ ok: true, tickets: result.results || [] });
  }

  if (request.method === 'GET' && path === '/api/tournaments/me') {
    return json({ok:true,...(await myRecurringTournamentData(env.DB,user.id))});
  }

  const gameResponse = await advanceServerGame(env.DB, user, request, path);
  if (gameResponse) return gameResponse;

  if (request.method === 'POST' && path === '/api/tournaments/register') {
    return registerRecurringTournament(env.DB,user,request);
  }

  const roomResponse = await handleRoom(env.DB, request, user, path);
  if (roomResponse) return roomResponse;
  return json({ error: 'روش درخواست برای این مسیر پشتیبانی نمی‌شود.' }, 405);
}

export async function onRequest({ request, env }) {
  try {
    return await routeRequest(request, env);
  } catch (error) {
    const status = Number(error?.status) || 500;
    const requestId = randomToken(8);
    if (status >= 500) {
      // Log technical diagnostics only; never log request bodies, email addresses, or passwords.
      console.error('[dabernaz-api-error]', JSON.stringify({
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status,
        name: error?.name || 'Error',
        message: String(error?.message || error),
        stack: typeof error?.stack === 'string' ? error.stack : undefined,
        cause: error?.cause ? String(error.cause?.message || error.cause) : undefined,
      }));
    }
    const message = status >= 500 ? 'خطای داخلی سرور رخ داد. تنظیم D1 و گزارش‌های Worker را بررسی کن.' : error.message;
    const testDiagnostics = env.DABERNAZ_TEST_DIAGNOSTICS === '1' && status >= 500
      ? { debug: { name: error?.name || 'Error', message: String(error?.message || error), stack: typeof error?.stack === 'string' ? error.stack : undefined } }
      : {};
    return json({ error: message, ...(status >= 500 ? { requestId } : {}), ...(error?.extra || {}), ...testDiagnostics }, status);
  }
}