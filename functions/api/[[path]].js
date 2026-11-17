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
const PASSWORD_ITERATIONS = 600000;
const DUMMY_PASSWORD_HASH = 'pbkdf2$600000$00112233445566778899aabbccddeeff$488c95bb261cd14fae230743a6f0fe216edec7423d168135a783ce15c653ace8';
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
    if (kind !== 'pbkdf2' || !Number.isInteger(rounds) || rounds < 50000 || rounds > 600000) return false;
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

async function assertSchemaReady(db) {
  if (bootstrappedBindings.has(db)) return;
  try {
    const row = await db.prepare('SELECT MAX(version) AS version FROM schema_migrations').first();
    if (Number(row?.version) < 1) {
      throw new HttpError(503, 'ساختار پایگاه داده هنوز به نسخه موردنیاز ارتقا نیافته است.');
    }
    const required = await db.prepare(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('users','auth_sessions','transactions','room_rounds','room_purchases','room_outbox','financial_ledger','referral_reward_claims','wallet_adjustment_requests')"
    ).first();
    if (Number(required?.total) !== 9) {
      throw new HttpError(503, 'بخشی از ساختار پایگاه داده ناقص است؛ اجرای Migration لازم است.');
    }
    bootstrappedBindings.add(db);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'نسخه Migration پایگاه داده در دسترس نیست؛ اجرای Migration محیط Preview لازم است.');
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
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_game_sessions_one_active ON game_sessions(user_id,game_type) WHERE status='playing'`,
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
    `CREATE TABLE IF NOT EXISTS wallet_payment_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      card_number TEXT NOT NULL DEFAULT '',
      card_holder TEXT NOT NULL DEFAULT '',
      bank_name TEXT NOT NULL DEFAULT '',
      payment_note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS wallet_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sender_type TEXT NOT NULL CHECK(sender_type IN ('user','admin')),
      message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 1000),
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wallet_messages_user ON wallet_messages(user_id,id DESC)`,
    `CREATE TABLE IF NOT EXISTS manual_wallet_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      request_type TEXT NOT NULL CHECK(request_type IN ('deposit','withdraw')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      status TEXT NOT NULL,
      receipt_data_url TEXT,
      receipt_mime TEXT,
      card_number TEXT,
      card_holder TEXT,
      bank_name TEXT,
      user_note TEXT NOT NULL DEFAULT '',
      payment_card_number TEXT NOT NULL DEFAULT '',
      payment_card_holder TEXT NOT NULL DEFAULT '',
      payment_bank_name TEXT NOT NULL DEFAULT '',
      payment_note TEXT NOT NULL DEFAULT '',
      admin_note TEXT,
      handled_by INTEGER,
      handled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(handled_by) REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_manual_wallet_requests_user ON manual_wallet_requests(user_id,id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_manual_wallet_requests_status ON manual_wallet_requests(status,id DESC)`,
    `CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      sender_user_id INTEGER,
      sender_role TEXT NOT NULL CHECK(sender_role IN ('user','admin')),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_user_id) REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, id ASC)`,
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
  const walletRequestInfo = await db.prepare('PRAGMA table_info(manual_wallet_requests)').all();
  const walletRequestColumns = new Set((walletRequestInfo.results || []).map((item) => item.name));
  const walletRequestAdditions = [
    ['user_note', "TEXT NOT NULL DEFAULT ''"],
    ['payment_card_number', "TEXT NOT NULL DEFAULT ''"],
    ['payment_card_holder', "TEXT NOT NULL DEFAULT ''"],
    ['payment_bank_name', "TEXT NOT NULL DEFAULT ''"],
    ['payment_note', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of walletRequestAdditions) {
    if (!walletRequestColumns.has(name)) {
      try { await db.prepare(`ALTER TABLE manual_wallet_requests ADD COLUMN ${name} ${definition}`).run(); }
      catch (error) {
        if (!String(error?.message || error).toLowerCase().includes('duplicate column')) throw error;
      }
    }
  }
  // One-time, idempotent migration: preserve the original customer message
  // for tickets created before threaded support was introduced.
  await db.prepare(`INSERT INTO support_messages (ticket_id,sender_user_id,sender_role,message,created_at)
    SELECT t.id,t.user_id,'user',t.message,t.created_at FROM support_tickets t
    WHERE NOT EXISTS (SELECT 1 FROM support_messages m WHERE m.ticket_id=t.id)`).run();
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
  // Authentication checks are read-only. Expired rows are pruned by a
  // scheduled maintenance task, never as a side effect of GET /api/auth/me.
  if (!row) return null;
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
    transactions: (await db.prepare('SELECT amount,description,created_at FROM transactions WHERE user_id=? AND type<>\'bingo_coin\' ORDER BY id DESC LIMIT 50').bind(row.id).all()).results.map((tx) => ({
      amount: Number(tx.amount) || 0,
      title: tx.description || 'تراکنش کیف پول',
      date: tx.created_at || '',
    })),
  };
}

async function readJson(request, maxBytes = 32768) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > maxBytes) throw new HttpError(413, 'درخواست بیش از حد بزرگ است.');
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(413, 'درخواست بیش از حد بزرگ است.');
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
  const ip = String(request.headers.get('cf-connecting-ip') || 'unknown').slice(0, 64);
  const normalizedEmail = String(email || '').trim().toLowerCase().slice(0, 190);
  const [pairCount, ipCount, emailCount] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip=? AND email=? AND attempted_at>?')
      .bind(ip, normalizedEmail, now - 600).first(),
    db.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip=? AND attempted_at>?')
      .bind(ip, now - 600).first(),
    db.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE email=? AND attempted_at>?')
      .bind(normalizedEmail, now - 600).first(),
  ]);
  if (Number(pairCount?.n || 0) >= 10 ||
      Number(emailCount?.n || 0) >= 10 ||
      Number(ipCount?.n || 0) >= 30) {
    throw new HttpError(429, 'تعداد تلاش‌ها زیاد است. ده دقیقه بعد دوباره تلاش کن.');
  }
  await db.prepare('INSERT INTO auth_attempts (ip, email, attempted_at) VALUES (?, ?, ?)')
    .bind(ip, normalizedEmail, now).run();
  await db.prepare('DELETE FROM auth_attempts WHERE attempted_at < ?').bind(now - 3600).run();
  return { ip, email:normalizedEmail };
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

  if (request.method === 'POST' && path === '/api/auth/logout-all') {
    validateWriteOrigin(request);
    const user = await authenticatedUser(db, request);
    if (!user) throw new HttpError(401, 'نشست کاربری معتبر نیست.');
    await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true, allSessionsRevoked: true }, 200, { 'set-cookie': expiredCookie(request) });
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
      if (existing) throw new HttpError(409, 'با این اطلاعات امکان ساخت حساب وجود ندارد.');
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
          throw new HttpError(409, 'با این اطلاعات امکان ساخت حساب وجود ندارد.');
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
        const [legacyRewards, claimState] = await Promise.all([
          db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND type='referral_reward'").bind(inviter.id).first(),
          db.prepare('SELECT COALESCE(MAX(milestone),0) AS n FROM referral_reward_claims WHERE inviter_id=?').bind(inviter.id).first(),
        ]);
        const alreadyRewarded = Math.max(Number(legacyRewards?.n || 0), Number(claimState?.n || 0));
        if (milestones > alreadyRewarded) {
          const nowText = new Date().toISOString();
          for (let milestone = alreadyRewarded + 1; milestone <= milestones; milestone++) {
            const referenceId = String(inviter.id) + ':' + String(milestone);
            await db.batch([
              db.prepare('INSERT INTO referral_reward_claims(inviter_id,milestone,referral_count,created_at) VALUES(?,?,?,?) ON CONFLICT(inviter_id,milestone) DO NOTHING')
                .bind(inviter.id, milestone, Number(referralCount?.n || 0), nowText),
              db.prepare('UPDATE users SET balance=balance+20000,bingo_coins=bingo_coins+5 WHERE id=? AND changes()=1')
                .bind(inviter.id),
              db.prepare("INSERT INTO transactions(user_id,type,amount,description,created_at) SELECT ?,'referral_reward',20000,?,? WHERE changes()=1")
                .bind(inviter.id, 'پاداش ' + String(milestone * 5) + ' دعوت موفق', nowText),
              db.prepare("INSERT INTO transactions(user_id,type,amount,description,created_at) SELECT ?,'bingo_coin',5,?,? WHERE changes()=1")
                .bind(inviter.id, '۵ بینگوکوین پاداش ' + String(milestone * 5) + ' دعوت موفق', nowText),
              db.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'toman',20000,'referral_reward','referral_milestone',?,? WHERE changes()=1")
                .bind(randomToken(16), inviter.id, referenceId, Date.now()),
              db.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'bingo_coin',5,'referral_reward','referral_milestone',?,? WHERE changes()=1")
                .bind(randomToken(16), inviter.id, referenceId, Date.now()),
            ]);
          }
        }
      }
    } else {
      userRow = await db.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').bind(email).first();
      const valid = userRow
        ? await verifyPassword(password, userRow.password_hash)
        : await verifyPassword(password, DUMMY_PASSWORD_HASH).then(() => false);
      if (!valid) throw new HttpError(401, 'ایمیل یا رمز عبور اشتباه است.');

      // Opportunistically upgrade legacy hashes after a valid login. New
      // registrations use PBKDF2-HMAC-SHA256 with 600k iterations.
      const storedRounds = Number(String(userRow.password_hash || '').split('$')[1]) || 0;
      if (storedRounds < PASSWORD_ITERATIONS) {
        const upgradedHash = await hashPassword(password);
        await db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?')
          .bind(upgradedHash, userRow.id, userRow.password_hash).run();
      }
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

async function handleRoom(db, request, user, path, env) {
  const match = path.match(/^\/api\/rooms\/(room5000|room10000|room20000|room50000)(?:\/(join|leave|next))?$/);
  if (!match) return null;

  // All room reads and mutations are delegated to the private, per-room
  // Durable Object coordinator. Never fall back to the legacy JSON room state:
  // doing so could create a second source of truth and an unsafe financial path.
  if (!env?.ROOM_COORDINATOR || typeof env.ROOM_COORDINATOR.fetch !== 'function') {
    return json({
      ok: false,
      code: 'ROOM_COORDINATOR_UNAVAILABLE',
      error: 'زیرساخت امن اتاق بازی هنوز در محیط Preview متصل نشده است. خرید کارت موقتاً غیرفعال است.',
    }, 503);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    validateWriteOrigin(request);
  }

  const [, roomId] = match;
  const forwardedPath = path.replace(/^\/api/, '');
  const target = 'https://dabernaz-room-coordinator.internal' + forwardedPath + new URL(request.url).search;
  const headers = new Headers(request.headers);

  // Never accept an identity header supplied by the browser. The Pages API
  // overwrites it only after authenticatedUser() has validated the session.
  headers.delete('x-dabernaz-user-id');
  if (user?.id) headers.set('x-dabernaz-user-id', String(user.id));
  headers.set('x-dabernaz-room-id', roomId);

  const init = {
    method: request.method,
    headers,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.clone().arrayBuffer();
  }

  const forwardedRequest = new Request(target, init);
  return env.ROOM_COORDINATOR.fetch(forwardedRequest);
}

async function ensureWalletRequestIdempotencySchema(db) {
  try {
    await db.prepare('SELECT 1 FROM wallet_request_idempotency LIMIT 1').first();
  } catch (_) {
    throw new HttpError(503, 'ثبت امن درخواست‌های کیف پول تا اجرای Migration شماره ۲ موقتاً غیرفعال است.');
  }
}

async function findWalletRequestReplay(db, userId, idempotencyKey, requestHash) {
  let claim;
  try {
    claim = await db.prepare(
      'SELECT request_hash,request_id FROM wallet_request_idempotency WHERE user_id=? AND idempotency_key=?'
    ).bind(userId, idempotencyKey).first();
  } catch (_) {
    throw new HttpError(503, 'ساختار Idempotency کیف پول آماده نیست؛ Migration شماره ۲ لازم است.');
  }
  if (!claim) return null;
  if (String(claim.request_hash) !== requestHash) {
    throw new HttpError(409, 'این کلید یکتا قبلاً با اطلاعات متفاوتی استفاده شده است.');
  }
  const requestId = Number(claim.request_id);
  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    throw new HttpError(503, 'نتیجه درخواست مالی در وضعیت بازیابی است؛ دوباره وضعیت کیف پول را دریافت کن.');
  }
  const existing = await db.prepare(
    'SELECT id,request_type,amount,status FROM manual_wallet_requests WHERE id=? AND user_id=?'
  ).bind(requestId, userId).first();
  if (!existing) throw new HttpError(503, 'مرجع درخواست مالی با رکورد پایدار آن تطبیق ندارد.');
  return existing;
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
  const parse = (value) => {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed)
        ? parsed.map(({name,memberId,number,at}) => ({name,memberId,number,at}))
        : [];
    } catch (_) { return []; }
  };
  return (result.results || []).map((row) => ({
    room_id: row.room_id,
    round_id: row.round_id,
    total_players: Number(row.total_players) || 0,
    total_cards: Number(row.total_cards) || 0,
    line_prize_paid: Number(row.line_prize_paid) || 0,
    full_prize_paid: Number(row.full_prize_paid) || 0,
    finished_at: row.finished_at,
    lineWinners: parse(row.line_winners_json),
    fullWinners: parse(row.full_winners_json),
    finishedAt: row.finished_at,
  }));
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
    const active=await db.prepare("SELECT id,game_type,state_json FROM game_sessions WHERE user_id=? AND game_type=? AND status='playing' ORDER BY created_at DESC LIMIT 1").bind(user.id,gameType).first();
    if(active) return json({ok:true,match:publicGameSession(active,JSON.parse(active.state_json))});
    const id=randomToken(16), now=new Date().toISOString();
    const state=gameType==='rps'?{round:1,player:0,bot:0,draws:0,history:[],rounds:[],finished:false,result:null}:{board:Array(9).fill(''),moves:0,finished:false,result:null};
    try {
      await db.prepare("INSERT INTO game_sessions (id,user_id,game_type,state_json,status,created_at,updated_at) VALUES (?,?,?,?,'playing',?,?)")
        .bind(id,user.id,gameType,JSON.stringify(state),now,now).run();
    } catch (error) {
      const activeNow = await db.prepare("SELECT id,game_type,state_json FROM game_sessions WHERE user_id=? AND game_type=? AND status='playing' ORDER BY created_at DESC LIMIT 1")
        .bind(user.id,gameType).first();
      if (activeNow) return json({ok:true,match:publicGameSession(activeNow,JSON.parse(activeNow.state_json))});
      throw error;
    }
    return json({ok:true,match:publicGameSession({id,game_type:gameType},state)});
  }
  if(request.method==='GET'&&path==='/api/games/active'){
    const gameType=new URL(request.url).searchParams.get('gameType');
    if(!['rps','tic'].includes(gameType||'')) throw new HttpError(400,'نوع بازی معتبر نیست.');
    const row=await db.prepare("SELECT id,game_type,state_json FROM game_sessions WHERE user_id=? AND game_type=? AND status='playing' ORDER BY created_at DESC LIMIT 1").bind(user.id,gameType).first();
    return json({ok:true,match:row?publicGameSession(row,JSON.parse(row.state_json)):null});
  }
  if(request.method==='POST'&&path==='/api/games/abandon'){
    validateWriteOrigin(request);
    const body=await readJson(request), matchId=String(body.matchId||'');
    if(!/^[0-9a-f]{32}$/i.test(matchId)) throw new HttpError(400,'شناسه مسابقه معتبر نیست.');
    const updated=await db.prepare("UPDATE game_sessions SET status='abandoned',updated_at=? WHERE id=? AND user_id=? AND status='playing'")
      .bind(new Date().toISOString(),matchId,user.id).run();
    if(Number(updated.meta?.changes||0)) return json({ok:true,abandoned:true});
    const existing=await db.prepare("SELECT status FROM game_sessions WHERE id=? AND user_id=? LIMIT 1").bind(matchId,user.id).first();
    if(!existing) throw new HttpError(404,'مسابقه پیدا نشد.');
    if(existing.status==='abandoned') return json({ok:true,abandoned:true});
    if(existing.status==='finished') return json({ok:true,abandoned:false});
    throw new HttpError(409,'وضعیت این مسابقه تغییر کرده است؛ دوباره دریافتش کن.');
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
      statements.push(db.prepare("INSERT INTO game_results (user_id,game_type,result,prize,bingo_coins_earned,created_at) SELECT user_id,game_type,?,0,0,? FROM game_sessions WHERE id=? AND status='finished' AND updated_at=? AND changes()=1").bind(finalResult,now,matchId,now));
      statements.push(db.prepare(`UPDATE users SET games_played=games_played+1,wins=wins+CASE WHEN ?='win' THEN 1 ELSE 0 END,points=points+CASE WHEN ?='win' THEN 10 ELSE 0 END WHERE id=(SELECT user_id FROM game_sessions WHERE id=? AND status='finished' AND updated_at=?) AND changes()=1`).bind(finalResult,finalResult,matchId,now));
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
          .bind(row.user_id, row.entry_cost, "بازگشت ورودی " + tournamentTitle(event.tournament_type), nowText),
        db.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'bingo_coin',?,'tournament_refund','tournament_entry',?,? WHERE changes()=1")
          .bind(randomToken(16), row.user_id, row.entry_cost, String(event.id) + ':' + String(row.user_id), Date.now())
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
  const scores = scoreTournamentPlayers(
    players,
    parseTournamentArray(round.called_numbers_json),
    tournamentType,
    parseTournamentArray(round.line_winner_ids_json)
  );
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
  const result = await db.prepare("SELECT e.user_id,e.total_points,e.line_wins,e.full_wins,e.rounds_played,e.created_at,u.member_id FROM tournament_event_entries e JOIN users u ON u.id=e.user_id WHERE e.event_id=? AND e.status IN ('registered','qualified') ORDER BY e.total_points DESC,e.full_wins DESC,e.line_wins DESC,e.rounds_played DESC,e.created_at ASC,u.member_id ASC,e.user_id ASC")
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
      db.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'bingo_coin',?,'tournament_prize','tournament_prize',?,? WHERE changes()=1")
        .bind(randomToken(16), player.user_id, amount, String(event.id) + ':rank:' + String(index + 1) + ':user:' + String(player.user_id), Date.now()),
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
    const update = await db.prepare("UPDATE tournament_events SET status='cancelled',stage='cancelled',registered_count=?,prize_pool=0,finished_at=?,updated_at=? WHERE id=? AND status IN ('scheduled','registration')")
      .bind(playerCount, nowText, nowText, event.id).run();
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
  const active = await db.prepare("SELECT * FROM tournament_events e WHERE e.status IN ('scheduled','registration','running') OR (e.status='cancelled' AND EXISTS (SELECT 1 FROM tournament_event_entries pending WHERE pending.event_id=e.id AND pending.status='registered')) ORDER BY e.scheduled_at ASC LIMIT 12")
    .all();
  for (const event of active.results || []) {
    await advanceTournamentEvent(db, event, current, advanceDraws);
  }
  await ensureRecurringTournamentSchedule(db, current + 1000);
}

async function recurringTournamentSnapshots(db, advanceDraws = true) {
  if (advanceDraws) await advanceTournamentSystem(db, Date.now(), true);
  const rows = await db.prepare("SELECT * FROM tournament_events ORDER BY CASE WHEN status IN ('scheduled','registration','running') THEN 0 ELSE 1 END,scheduled_at ASC LIMIT 12").all();
  const output = [];
  for (const event of rows.results || []) {
    const round = event.current_round_id
      ? await db.prepare("SELECT * FROM tournament_rounds WHERE id=?").bind(event.current_round_id).first()
      : null;
    const leaders = await db.prepare("SELECT u.username,u.member_id,e.total_points,e.line_wins,e.full_wins,e.status,e.user_id FROM tournament_event_entries e JOIN users u ON u.id=e.user_id WHERE e.event_id=? AND e.status IN ('registered','qualified','winner_1','winner_2','winner_3') ORDER BY e.total_points DESC,e.full_wins DESC,e.line_wins DESC,e.rounds_played DESC,e.created_at ASC,u.member_id ASC,e.user_id ASC LIMIT 5")
      .bind(event.id).all();
    const lineWinnerIds = round ? parseTournamentArray(round.line_winner_ids_json).map(Number) : [];
    const fullWinnerIds = round ? parseTournamentArray(round.full_winner_ids_json).map(Number) : [];
    const winnerIds = [...new Set([...lineWinnerIds, ...fullWinnerIds])]
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    const winnerProfiles = new Map();
    if (winnerIds.length) {
      const placeholders = winnerIds.map(() => '?').join(',');
      const profiles = await db.prepare(
        'SELECT id,username,member_id FROM users WHERE id IN (' + placeholders + ')'
      ).bind(...winnerIds).all();
      for (const profile of profiles.results || []) {
        winnerProfiles.set(Number(profile.id), {
          name: profile.username,
          memberId: String(profile.member_id || '')
        });
      }
    }
    const publicWinners = (ids) => ids.map((id) => winnerProfiles.get(Number(id)) || {
      name: 'بازیکن',
      memberId: ''
    });

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
        full_winner_ids: parseTournamentArray(round.full_winner_ids_json),
        line_winners: publicWinners(lineWinnerIds),
        full_winners: publicWinners(fullWinnerIds)
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
      .bind(user.id, -cost, "ورود به " + tournamentTitle(type), nowText),
    db.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'bingo_coin',?,'tournament_entry','tournament_entry',?,? WHERE changes()=1")
      .bind(randomToken(16), user.id, -cost, String(event.id) + ':' + String(user.id), Date.now())
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
  // GET /api/tournaments/me must be read-only. The authenticated scheduler
  // endpoint is the sole entry point that advances tournament state and draws.
  const events = await recurringTournamentSnapshots(db, false);
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
    event.my_line_hit = parseTournamentArray(event.current_round.line_winner_ids)
      .some((winnerId) => String(winnerId) === String(userId));
    event.my_full_hit = parseTournamentArray(event.current_round.full_winner_ids)
      .some((winnerId) => String(winnerId) === String(userId));
    event.my_entry_status = ownEntry.status;
    event.my_total_points = Number(ownEntry.total_points) || 0;
  }
  // Internal database user IDs are never needed by the browser. Public player
  // IDs and winner profiles are sufficient for the live tournament UI.
  for (const event of events) {
    if (!event.current_round) continue;
    delete event.current_round.line_winner_ids;
    delete event.current_round.full_winner_ids;
  }
  const wallet = await db.prepare("SELECT bingo_coins FROM users WHERE id=?").bind(userId).first();
  return {
    events,
    entries: ownedEntries,
    rooms: events,
    bingo_coins: Number(wallet && wallet.bingo_coins) || 0
  };
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

  // Health reports both the Pages/D1 API and the independent room-coordinator
  // binding. A healthy D1 alone must never make an unconnected game engine look
  // ready. The route is read-only and intentionally does not advance any state.
  if (request.method === 'GET' && path === '/api/health') {
    if (!env.DB) {
      return json({
        ok: false,
        service: 'dabernaz',
        backend: 'cloudflare-pages-functions',
        database: 'missing',
        schema: 'unknown',
        roomCoordinator: { available: false },
        readiness: 'misconfigured',
        mode: 'misconfigured',
      }, 503);
    }
    try {
      const row = await env.DB.prepare('SELECT 1 AS ok').first();
      if (Number(row?.ok) !== 1) throw new Error('D1 health query returned an unexpected result.');
      await assertSchemaReady(env.DB);
      const roomCoordinatorAvailable = typeof env.ROOM_COORDINATOR?.fetch === 'function';
      const readiness = roomCoordinatorAvailable ? 'ready' : 'degraded';
      return json({
        ok: true,
        service: 'dabernaz',
        backend: 'cloudflare-pages-functions',
        database: 'D1',
        schema: 'v1',
        binding: 'bound',
        roomCoordinator: {
          available: roomCoordinatorAvailable,
          binding: 'ROOM_COORDINATOR',
        },
        readiness,
        mode: readiness,
        unavailableFeatures: roomCoordinatorAvailable ? [] : ['paid_rooms'],
      });
    } catch (error) {
      const message = error instanceof HttpError ? error.message : 'D1 is unreachable or the required schema is unavailable.';
      return json({
        ok: false,
        service: 'dabernaz',
        backend: 'cloudflare-pages-functions',
        database: 'unreachable_or_unready',
        schema: 'unknown',
        roomCoordinator: { available: typeof env.ROOM_COORDINATOR?.fetch === 'function' },
        readiness: 'degraded',
        mode: 'degraded',
        error: message,
      }, 503);
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
  if (env.DABERNAZ_TEST_DIAGNOSTICS === '1') await ensureSchema(env.DB);
  else await assertSchemaReady(env.DB);

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

  const isProtected = path === '/api/profile' || path.startsWith('/api/games/') || path.startsWith('/api/rooms/') || path.startsWith('/api/wallet') || path.startsWith('/api/admin/wallet') || path === '/api/referrals' || path === '/api/support' || path.startsWith('/api/tickets') || path.startsWith('/api/admin/support') || path === '/api/tournaments/me' || path === '/api/tournaments/register';
  if (!isProtected) return json({ error: 'مسیر API پیدا نشد.' }, 404);
  const user = await authenticatedUser(env.DB, request);
  if (!user) throw new HttpError(401, 'برای ادامه ابتدا وارد حساب کاربری شو.');

  const supportAdminIds=String(env.SUPPORT_ADMIN_MEMBER_IDS||'').split(',').map(v=>v.trim()).filter(Boolean);
  const isSupportAdmin=supportAdminIds.includes(String(user.member_id||''));
  // Backward compatibility: on deployments without a dedicated finance allowlist,
  // the already-configured support administrator allowlist remains the authorized operator set.
  const walletAdminIds=String(env.WALLET_ADMIN_MEMBER_IDS||env.SUPPORT_ADMIN_MEMBER_IDS||'').split(',').map(v=>v.trim()).filter(Boolean);
  const isWalletAdmin=walletAdminIds.includes(String(user.member_id||''));

  if (path.startsWith('/api/admin/wallet')) {
    if (!isWalletAdmin) throw new HttpError(403, 'دسترسی مدیر مالی برای این حساب فعال نیست.');
    if (request.method === 'GET' && path === '/api/admin/wallet') {
      const status = String(new URL(request.url).searchParams.get('status') || 'all');
      const allowed = ['all','awaiting_receipt','pending_review','pending_transfer','approved','rejected','paid','cancelled'];
      if (!allowed.includes(status)) throw new HttpError(400, 'فیلتر وضعیت درخواست مالی معتبر نیست.');
      const rows = await env.DB.prepare(
        'SELECT r.id,r.request_type,r.amount,r.status,r.card_number,r.card_holder,r.bank_name,r.user_note,r.admin_note,r.created_at,r.updated_at,r.handled_at,' +
        'u.username,u.member_id,u.email,u.balance,CASE WHEN r.receipt_data_url IS NULL THEN 0 ELSE 1 END AS has_receipt ' +
        'FROM manual_wallet_requests r JOIN users u ON u.id=r.user_id ' +
        (status === 'all' ? '' : 'WHERE r.status=? ') + 'ORDER BY r.id DESC LIMIT 300'
      );
      const result = status === 'all' ? await rows.all() : await rows.bind(status).all();
      const counts = await env.DB.prepare('SELECT status,COUNT(*) AS total FROM manual_wallet_requests GROUP BY status').all();
      return json({ok:true,isAdmin:true,requests:result.results || [],counts:counts.results || []});
    }
    if (request.method === 'GET' && path === '/api/admin/wallet/settings') {
      const row = await env.DB.prepare('SELECT card_number,card_holder,bank_name,payment_note,updated_at FROM wallet_payment_settings WHERE id=1').first();
      return json({ok:true,settings:{cardNumber:row?.card_number || '',cardHolder:row?.card_holder || '',bankName:row?.bank_name || '',paymentNote:row?.payment_note || '',updatedAt:row?.updated_at || ''}});
    }
    if (request.method === 'POST' && path === '/api/admin/wallet/settings') {
      validateWriteOrigin(request);
      const body = await readJson(request);
      const cardNumber = String(body.cardNumber || '').replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/\D/g, '');
      const cardHolder = String(body.cardHolder || '').trim();
      const bankName = String(body.bankName || '').trim();
      const paymentNote = String(body.paymentNote || '').trim();
      if (cardNumber && !/^\d{16}$/.test(cardNumber)) throw new HttpError(400, 'شماره کارت مقصد باید ۱۶ رقم باشد.');
      if (cardNumber && (cardHolder.length < 2 || cardHolder.length > 80)) throw new HttpError(400, 'نام صاحب کارت مقصد معتبر نیست.');
      if (bankName.length > 60 || paymentNote.length > 400) throw new HttpError(400, 'اطلاعات حساب مقصد بیش از حد طولانی است.');
      const now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO wallet_payment_settings(id,card_number,card_holder,bank_name,payment_note,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET card_number=excluded.card_number,card_holder=excluded.card_holder,bank_name=excluded.bank_name,payment_note=excluded.payment_note,updated_at=excluded.updated_at')
        .bind(cardNumber,cardHolder,bankName,paymentNote,now).run();
      return json({ok:true,settings:{cardNumber,cardHolder,bankName,paymentNote,updatedAt:now}});
    }
    if (request.method === 'GET' && path === '/api/admin/wallet/messages') {
      const memberId = String(new URL(request.url).searchParams.get('member_id') || '').trim();
      if (!/^\d{4,12}$/.test(memberId)) throw new HttpError(400, 'شناسه کاربر معتبر نیست.');
      const target = await env.DB.prepare('SELECT id,member_id,username FROM users WHERE member_id=? LIMIT 1').bind(memberId).first();
      if (!target) throw new HttpError(404, 'کاربر پیدا نشد.');
      const rows = await env.DB.prepare('SELECT id,sender_type,message,created_at FROM wallet_messages WHERE user_id=? ORDER BY id ASC LIMIT 200').bind(target.id).all();
      return json({ok:true,user:{memberId:target.member_id,username:target.username},messages:rows.results || []});
    }
    if (request.method === 'POST' && path === '/api/admin/wallet/messages') {
      validateWriteOrigin(request);
      const body = await readJson(request);
      const memberId = String(body.memberId || '').trim();
      const message = String(body.message || '').trim();
      if (!/^\d{4,12}$/.test(memberId)) throw new HttpError(400, 'شناسه کاربر معتبر نیست.');
      if (!message || message.length > 1000) throw new HttpError(400, 'پیام باید بین ۱ تا ۱۰۰۰ نویسه باشد.');
      const target = await env.DB.prepare('SELECT id FROM users WHERE member_id=? LIMIT 1').bind(memberId).first();
      if (!target) throw new HttpError(404, 'کاربر پیدا نشد.');
      const now = new Date().toISOString();
      const inserted = await env.DB.prepare("INSERT INTO wallet_messages(user_id,sender_type,message,created_at) VALUES(?,'admin',?,?)").bind(target.id,message,now).run();
      return json({ok:true,message:{id:Number(inserted.meta?.last_row_id||0),sender_type:'admin',message,created_at:now}});
    }
    if (request.method === 'GET' && path === '/api/admin/wallet/users') {
      const q = String(new URL(request.url).searchParams.get('q') || '').trim().slice(0,80);
      if (q.length < 2) return json({ok:true,users:[]});
      const like = '%' + q + '%';
      const rows = await env.DB.prepare("SELECT id,member_id,username,email,balance FROM users WHERE member_id=? OR username LIKE ? OR email LIKE ? ORDER BY id DESC LIMIT 25")
        .bind(q,like,like).all();
      return json({ok:true,users:rows.results || []});
    }
    if (request.method === 'POST' && path === '/api/admin/wallet/adjust') {
      validateWriteOrigin(request);
      const body = await readJson(request);
      const memberId = String(body.memberId || '').trim();
      const amount = Number(body.amount);
      const reason = String(body.reason || '').trim();
      if (!/^\d{4,12}$/.test(memberId)) throw new HttpError(400, 'شناسه بازیکن معتبر نیست.');
      if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 50000000) throw new HttpError(400, 'مبلغ اصلاح موجودی معتبر نیست.');
      if (reason.length < 3 || reason.length > 180) throw new HttpError(400, 'علت اصلاح موجودی باید بین ۳ تا ۱۸۰ نویسه باشد.');
      const target = await env.DB.prepare('SELECT id,username,member_id,email,balance FROM users WHERE member_id=? LIMIT 1').bind(memberId).first();
      if (!target) throw new HttpError(404, 'کاربری با این شناسه پیدا نشد.');
      const idempotencyKey = String(request.headers.get('idempotency-key') || '');
      if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
        throw new HttpError(400, 'کلید یکتای اصلاح موجودی معتبر نیست؛ دوباره تلاش کن.');
      }
      const requestHash = await sha256Hex(JSON.stringify({targetUserId:Number(target.id),amount,reason}));
      const prior = await env.DB.prepare(
        'SELECT request_hash,status,target_user_id FROM wallet_adjustment_requests WHERE admin_user_id=? AND idempotency_key=?'
      ).bind(user.id,idempotencyKey).first();
      if (prior) {
        if (prior.request_hash !== requestHash) throw new HttpError(409, 'این کلید برای اطلاعات اصلاح موجودی متفاوتی استفاده شده است.');
        if (prior.status !== 'applied') throw new HttpError(409, 'درخواست قبلی اعمال نشده است؛ برای عملیات جدید کلید تازه بساز.');
        const replayUser = await env.DB.prepare('SELECT id,username,member_id,email,balance FROM users WHERE id=?').bind(target.id).first();
        return json({ok:true,user:replayUser,replayed:true});
      }

      const now = new Date().toISOString();
      const adjustmentId = randomToken(16);
      const result = await env.DB.batch([
        env.DB.prepare("INSERT INTO wallet_adjustment_requests(id,admin_user_id,idempotency_key,request_hash,target_user_id,amount,reason,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT(admin_user_id,idempotency_key) DO NOTHING")
          .bind(adjustmentId,user.id,idempotencyKey,requestHash,target.id,amount,reason,Date.now()),
        env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=? AND balance+?>=0 AND changes()=1')
          .bind(amount,target.id,amount),
        env.DB.prepare("UPDATE wallet_adjustment_requests SET status=CASE WHEN changes()=1 THEN 'applied' ELSE 'rejected' END WHERE admin_user_id=? AND idempotency_key=? AND status='pending'")
          .bind(user.id,idempotencyKey),
        env.DB.prepare("INSERT INTO transactions(user_id,type,amount,description,created_at) SELECT ?, 'admin_adjustment',?,?,? WHERE changes()=1 AND EXISTS (SELECT 1 FROM wallet_adjustment_requests WHERE admin_user_id=? AND idempotency_key=? AND status='applied')")
          .bind(target.id,amount,'اصلاح موجودی توسط مدیر: '+reason,now,user.id,idempotencyKey),
        env.DB.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'toman',?,'admin_adjustment','wallet_adjustment',?,? WHERE changes()=1")
          .bind(randomToken(16),target.id,amount,adjustmentId,Date.now()),
      ]);

      if (Number(result?.[1]?.meta?.changes || 0) !== 1) {
        const saved = await env.DB.prepare(
          'SELECT request_hash,status FROM wallet_adjustment_requests WHERE admin_user_id=? AND idempotency_key=?'
        ).bind(user.id,idempotencyKey).first();
        if (saved?.request_hash !== requestHash) throw new HttpError(409, 'درخواست اصلاح موجودی هم‌زمان با اطلاعات متفاوت ثبت شد.');
        if (saved?.status === 'applied') {
          const replayUser = await env.DB.prepare('SELECT id,username,member_id,email,balance FROM users WHERE id=?').bind(target.id).first();
          return json({ok:true,user:replayUser,replayed:true});
        }
        throw new HttpError(409, 'موجودی کافی نیست یا درخواست اصلاح موجودی اعمال نشد.');
      }
      const updated = await env.DB.prepare('SELECT id,username,member_id,email,balance FROM users WHERE id=?').bind(target.id).first();
      return json({ok:true,user:updated,replayed:false});
    }
    const detailMatch = path.match(/^\/api\/admin\/wallet\/(\d+)$/);
    if (detailMatch && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT r.*,u.username,u.member_id,u.email,u.balance FROM manual_wallet_requests r JOIN users u ON u.id=r.user_id WHERE r.id=?').bind(Number(detailMatch[1])).first();
      if (!row) throw new HttpError(404, 'درخواست مالی پیدا نشد.');
      const receiptDataUrl = row.receipt_data_url || '';
      delete row.receipt_data_url;
      return json({ok:true,request:{...row,receiptDataUrl}});
    }
    const decisionMatch = path.match(/^\/api\/admin\/wallet\/(\d+)\/decision$/);
    if (decisionMatch && request.method === 'POST') {
      validateWriteOrigin(request);
      const id = Number(decisionMatch[1]);
      const body = await readJson(request);
      const decision = String(body.decision || '');
      const note = String(body.note || '').trim();
      if (!['approve','reject','paid'].includes(decision)) throw new HttpError(400, 'تصمیم مدیر معتبر نیست.');
      if (note.length > 500) throw new HttpError(400, 'یادداشت مدیر بیش از حد طولانی است.');
      const current = await env.DB.prepare('SELECT id,user_id,request_type,amount,status FROM manual_wallet_requests WHERE id=?').bind(id).first();
      if (!current) throw new HttpError(404, 'درخواست مالی پیدا نشد.');
      const now = new Date().toISOString();
      let batch;
      if (current.request_type === 'deposit') {
        if (!['approve','reject'].includes(decision)) throw new HttpError(400, 'برای واریز فقط تأیید یا رد مجاز است.');
        batch = await env.DB.batch([
          env.DB.prepare("UPDATE manual_wallet_requests SET status=?,admin_note=?,handled_by=?,handled_at=?,updated_at=? WHERE id=? AND request_type='deposit' AND status='pending_review'")
            .bind(decision === 'approve' ? 'approved' : 'rejected',note,user.id,now,now,id),
          env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=? AND changes()=1 AND ?='approve'").bind(Number(current.amount),Number(current.user_id),decision),
          env.DB.prepare("INSERT INTO transactions(user_id,type,amount,description,created_at) SELECT ?,'manual_deposit',?,?,? WHERE changes()=1").bind(Number(current.user_id),Number(current.amount),'شارژ دستی کیف پول · درخواست '+id,now),
          env.DB.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'toman',?,'manual_deposit','manual_wallet_request',?,? WHERE changes()=1")
            .bind(randomToken(16),Number(current.user_id),Number(current.amount),'deposit:'+String(id),Date.now()),
        ]);
      } else {
        if (!['paid','reject'].includes(decision)) throw new HttpError(400, 'برای برداشت فقط ثبت واریز یا رد درخواست مجاز است.');
        batch = await env.DB.batch([
          env.DB.prepare("UPDATE manual_wallet_requests SET status=?,admin_note=?,handled_by=?,handled_at=?,updated_at=? WHERE id=? AND request_type='withdraw' AND status='pending_transfer'")
            .bind(decision === 'paid' ? 'paid' : 'rejected',note,user.id,now,now,id),
          env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=? AND changes()=1 AND ?='reject'").bind(Number(current.amount),Number(current.user_id),decision),
          env.DB.prepare("INSERT INTO transactions(user_id,type,amount,description,created_at) SELECT ?,'withdrawal_refund',?,?,? WHERE changes()=1").bind(Number(current.user_id),Number(current.amount),'بازگشت وجه برداشت ردشده · درخواست '+id,now),
          env.DB.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'toman',?,'withdrawal_refund','manual_wallet_request',?,? WHERE changes()=1")
            .bind(randomToken(16),Number(current.user_id),Number(current.amount),'withdraw:'+String(id),Date.now()),
        ]);
      }
      if (Number(batch?.[0]?.meta?.changes || 0) !== 1) throw new HttpError(409, 'این درخواست قبلاً بررسی شده یا در وضعیت قابل بررسی نیست.');
      return json({ok:true,status:decision === 'approve' ? 'approved' : decision === 'paid' ? 'paid' : 'rejected'});
    }
    throw new HttpError(404, 'مسیر مدیریت کیف پول پیدا نشد.');
  }

  if (request.method === 'GET' && path === '/api/wallet/messages') {
    const rows = await env.DB.prepare('SELECT id,sender_type,message,created_at FROM wallet_messages WHERE user_id=? ORDER BY id ASC LIMIT 200').bind(user.id).all();
    return json({ok:true,messages:rows.results || []});
  }
  if (request.method === 'POST' && path === '/api/wallet/messages') {
    validateWriteOrigin(request);
    const body = await readJson(request);
    const message = String(body.message || '').trim();
    if (!message || message.length > 1000) throw new HttpError(400, 'پیام باید بین ۱ تا ۱۰۰۰ نویسه باشد.');
    const now = new Date().toISOString();
    const inserted = await env.DB.prepare("INSERT INTO wallet_messages(user_id,sender_type,message,created_at) VALUES(?,'user',?,?)").bind(user.id,message,now).run();
    return json({ok:true,message:{id:Number(inserted.meta?.last_row_id||0),sender_type:'user',message,created_at:now}});
  }
  const paymentInstructionsMatch = path.match(/^\/api\/wallet\/requests\/(\d+)\/payment-instructions$/);
  if (paymentInstructionsMatch && request.method === 'GET') {
    const requestId = Number(paymentInstructionsMatch[1]);
    const item = await env.DB.prepare("SELECT id,request_type,status,payment_card_number,payment_card_holder,payment_bank_name,payment_note FROM manual_wallet_requests WHERE id=? AND user_id=? LIMIT 1").bind(requestId,user.id).first();
    if (!item) throw new HttpError(404, 'درخواست واریز پیدا نشد.');
    if (item.request_type !== 'deposit' || item.status !== 'awaiting_receipt') throw new HttpError(409, 'اطلاعات پرداخت فقط برای درخواست واریزِ منتظر رسید در دسترس است.');
    let paymentInfo = {
      cardNumber: item.payment_card_number || '',
      cardHolder: item.payment_card_holder || '',
      bankName: item.payment_bank_name || '',
      paymentNote: item.payment_note || '',
    };
    // Older pending requests did not store a card snapshot; keep them usable with current admin settings.
    if (!paymentInfo.cardNumber) {
      const settings = await env.DB.prepare('SELECT card_number,card_holder,bank_name,payment_note FROM wallet_payment_settings WHERE id=1').first();
      paymentInfo = {
        cardNumber: settings?.card_number || '',
        cardHolder: settings?.card_holder || '',
        bankName: settings?.bank_name || '',
        paymentNote: settings?.payment_note || '',
      };
    }
    if (!paymentInfo.cardNumber) throw new HttpError(409, 'اطلاعات کارت مقصد هنوز توسط مدیریت تنظیم نشده است.');
    return json({ok:true,requestId,paymentInfo});
  }
  if (request.method === 'GET' && path === '/api/wallet/requests') {
    const rows = await env.DB.prepare('SELECT id,request_type,amount,status,user_note,admin_note,handled_at,created_at,updated_at,CASE WHEN receipt_data_url IS NULL THEN 0 ELSE 1 END AS has_receipt FROM manual_wallet_requests WHERE user_id=? ORDER BY id DESC LIMIT 50').bind(user.id).all();
    return json({ok:true,requests:rows.results || []});
  }
  if (request.method === 'POST' && path === '/api/wallet/requests') {
    validateWriteOrigin(request);
    await ensureWalletRequestIdempotencySchema(env.DB);
    const idempotencyKey = String(request.headers.get('idempotency-key') || '');
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new HttpError(400, 'کلید یکتای درخواست مالی معتبر نیست؛ دوباره تلاش کن.');
    }

    const body = await readJson(request);
    const requestType = String(body.type || '');
    const amount = Number(body.amount);
    if (!['deposit','withdraw'].includes(requestType)) throw new HttpError(400, 'نوع درخواست مالی معتبر نیست.');
    const minimumAmount = requestType === 'deposit' ? 105 : 205;
    if (!Number.isSafeInteger(amount) || amount < minimumAmount || amount > 50000000) {
      throw new HttpError(400, requestType === 'deposit'
        ? 'حداقل مبلغ واریز ۱۰۵ تومان و حداکثر آن ۵۰ میلیون تومان است.'
        : 'حداقل مبلغ برداشت ۲۰۵ تومان و حداکثر آن ۵۰ میلیون تومان است.');
    }
    const userNote = String(body.userNote || '').trim();
    if (userNote.length > 300) throw new HttpError(400, 'توضیحات درخواست حداکثر ۳۰۰ نویسه است.');
    const now = new Date().toISOString();
    const createdAt = Date.now();

    if (requestType === 'deposit') {
      const requestHash = await sha256Hex(JSON.stringify({type:requestType,amount,userNote}));
      const replay = await findWalletRequestReplay(env.DB,user.id,idempotencyKey,requestHash);
      if (replay) return json({ok:true,requestId:Number(replay.id),status:replay.status,replayed:true});

      const settings = await env.DB.prepare('SELECT card_number,card_holder,bank_name,payment_note FROM wallet_payment_settings WHERE id=1').first();
      if (!settings?.card_number) throw new HttpError(409, 'اطلاعات کارت مقصد هنوز توسط مدیریت تنظیم نشده است.');
      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO wallet_request_idempotency(user_id,idempotency_key,request_hash,request_id,created_at) ' +
          'VALUES(?,?,?,NULL,?) ON CONFLICT(user_id,idempotency_key) DO NOTHING'
        ).bind(user.id,idempotencyKey,requestHash,createdAt),
        env.DB.prepare(
          "INSERT INTO manual_wallet_requests(user_id,request_type,amount,status,user_note,payment_card_number,payment_card_holder,payment_bank_name,payment_note,created_at,updated_at) " +
          "SELECT ?,'deposit',?,'awaiting_receipt',?,?,?,?,?,?,? WHERE changes()=1"
        ).bind(user.id,amount,userNote,settings.card_number,settings.card_holder || '',settings.bank_name || '',settings.payment_note || '',now,now),
        env.DB.prepare(
          'UPDATE wallet_request_idempotency SET request_id=last_insert_rowid() WHERE user_id=? AND idempotency_key=? AND request_id IS NULL AND changes()=1'
        ).bind(user.id,idempotencyKey),
      ]);
      const result = await findWalletRequestReplay(env.DB,user.id,idempotencyKey,requestHash);
      if (!result) throw new HttpError(409, 'درخواست واریز ثبت نشد؛ اطلاعات را بررسی و دوباره تلاش کن.');
      return json({ok:true,requestId:Number(result.id),status:result.status,replayed:result.status!=='awaiting_receipt' || false});
    }

    const cardNumber = String(body.cardNumber || '').replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/\D/g, '');
    const cardHolder = String(body.cardHolder || '').trim();
    const bankName = String(body.bankName || '').trim();
    if (!/^\d{16}$/.test(cardNumber)) throw new HttpError(400, 'شماره کارت مقصد برای برداشت باید ۱۶ رقم باشد.');
    if (cardHolder.length < 2 || cardHolder.length > 80 || bankName.length > 60) throw new HttpError(400, 'مشخصات صاحب کارت معتبر نیست.');
    const requestHash = await sha256Hex(JSON.stringify({
      type:requestType,amount,userNote,cardNumber,cardHolder,bankName
    }));
    const replay = await findWalletRequestReplay(env.DB,user.id,idempotencyKey,requestHash);
    if (replay) return json({ok:true,requestId:Number(replay.id),status:replay.status,replayed:true});

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO wallet_request_idempotency(user_id,idempotency_key,request_hash,request_id,created_at) ' +
        'SELECT ?,?,?,NULL,? FROM users WHERE id=? AND balance>=? ' +
        'ON CONFLICT(user_id,idempotency_key) DO NOTHING'
      ).bind(user.id,idempotencyKey,requestHash,createdAt,user.id,amount),
      env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=? AND changes()=1')
        .bind(amount,user.id,amount),
      env.DB.prepare(
        "INSERT INTO manual_wallet_requests(user_id,request_type,amount,status,card_number,card_holder,bank_name,user_note,created_at,updated_at) " +
        "SELECT ?,'withdraw',?,'pending_transfer',?,?,?,?,?,? WHERE changes()=1"
      ).bind(user.id,amount,cardNumber,cardHolder,bankName,userNote,now,now),
      env.DB.prepare(
        'UPDATE wallet_request_idempotency SET request_id=last_insert_rowid() WHERE user_id=? AND idempotency_key=? AND request_id IS NULL AND changes()=1'
      ).bind(user.id,idempotencyKey),
      env.DB.prepare(
        "INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) " +
        "SELECT ?,?,'toman',?,'withdrawal_reserved','manual_wallet_request','withdraw:'||CAST(last_insert_rowid() AS TEXT),? WHERE changes()=1"
      ).bind(randomToken(16),user.id,-amount,createdAt),
      env.DB.prepare(
        "INSERT INTO transactions(user_id,type,amount,description,created_at) SELECT ?,'withdrawal_reserved',?,?,? WHERE changes()=1"
      ).bind(user.id,-amount,'رزرو موجودی برای درخواست برداشت',now),
    ]);
    const result = await findWalletRequestReplay(env.DB,user.id,idempotencyKey,requestHash);
    if (!result) throw new HttpError(409, 'موجودی کیف پول برای این برداشت کافی نیست یا درخواست ثبت نشد.');
    return json({ok:true,requestId:Number(result.id),status:result.status,replayed:true});
  }
  const receiptMatch = path.match(/^\/api\/wallet\/requests\/(\d+)\/receipt$/);
  if (receiptMatch && request.method === 'POST') {
    validateWriteOrigin(request);
    const id = Number(receiptMatch[1]);
    const body = await readJson(request,800000);
    const dataUrl = String(body.dataUrl || '');
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) throw new HttpError(400, 'رسید باید تصویر PNG، JPG یا WebP باشد.');
    const encoded = match[2];
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const size = Math.floor(encoded.length * 3 / 4) - padding;
    if (size < 100 || size > 512 * 1024) throw new HttpError(413, 'حجم تصویر رسید باید حداکثر ۵۱۲ کیلوبایت باشد.');
    const item = await env.DB.prepare("SELECT id,status FROM manual_wallet_requests WHERE id=? AND user_id=? AND request_type='deposit'").bind(id,user.id).first();
    if (!item) throw new HttpError(404, 'درخواست واریز پیدا نشد.');
    let headerBytes;
    try { headerBytes = atob(encoded.slice(0, 32)); } catch (_) { throw new HttpError(400, 'محتوای تصویر رسید معتبر نیست.'); }
    const byte = (index) => headerBytes.charCodeAt(index);
    const isPng = match[1] === 'image/png' && headerBytes.length >= 8 &&
      [137,80,78,71,13,10,26,10].every((value,index)=>byte(index)===value);
    const isJpeg = match[1] === 'image/jpeg' && headerBytes.length >= 3 &&
      byte(0)===255 && byte(1)===216 && byte(2)===255;
    const isWebp = match[1] === 'image/webp' && headerBytes.length >= 12 &&
      headerBytes.slice(0,4)==='RIFF' && headerBytes.slice(8,12)==='WEBP';
    if (!isPng && !isJpeg && !isWebp) throw new HttpError(400, 'محتوای فایل با فرمت تصویر اعلام‌شده مطابقت ندارد.');
    if (item.status !== 'awaiting_receipt') throw new HttpError(409, 'این درخواست در وضعیت دریافت رسید نیست.');
    const now = new Date().toISOString();
    const updated = await env.DB.prepare("UPDATE manual_wallet_requests SET receipt_data_url=?,receipt_mime=?,status='pending_review',updated_at=? WHERE id=? AND user_id=? AND status='awaiting_receipt'")
      .bind(dataUrl,match[1],now,id,user.id).run();
    if (Number(updated?.meta?.changes || 0) !== 1) throw new HttpError(409, 'این درخواست قبلاً رسید دریافت کرده یا وضعیت آن تغییر کرده است.');
    return json({ok:true,status:'pending_review'});
  }
  const cancelMatch = path.match(/^\/api\/wallet\/requests\/(\d+)\/cancel$/);
  if (cancelMatch && request.method === 'POST') {
    validateWriteOrigin(request);
    const id = Number(cancelMatch[1]);
    const item = await env.DB.prepare("SELECT id,user_id,amount FROM manual_wallet_requests WHERE id=? AND user_id=? AND request_type='withdraw' AND status='pending_transfer'").bind(id,user.id).first();
    if (!item) throw new HttpError(409, 'فقط درخواست برداشت در انتظار پرداخت را می‌توان لغو کرد.');
    const now = new Date().toISOString();
    const batch = await env.DB.batch([
      env.DB.prepare("UPDATE manual_wallet_requests SET status='cancelled',updated_at=? WHERE id=? AND user_id=? AND status='pending_transfer'").bind(now,id,user.id),
      env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=? AND changes()=1').bind(Number(item.amount),user.id),
      env.DB.prepare("INSERT INTO transactions(user_id,type,amount,description,created_at) SELECT ?,'withdrawal_cancel_refund',?,?,? WHERE changes()=1").bind(user.id,Number(item.amount),'بازگشت وجه با لغو درخواست برداشت · درخواست '+id,now),
      env.DB.prepare("INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) SELECT ?,?,'toman',?,'withdrawal_cancel_refund','manual_wallet_request',?,? WHERE changes()=1")
        .bind(randomToken(16),user.id,Number(item.amount),'withdraw:'+String(id),Date.now()),
    ]);
    if (Number(batch?.[0]?.meta?.changes || 0) !== 1) throw new HttpError(409, 'درخواست برداشت قبلاً پردازش شده است.');
    return json({ok:true,status:'cancelled'});
  }

  if(path.startsWith('/api/admin/support')){
    if(!isSupportAdmin) throw new HttpError(403,'دسترسی مدیر پشتیبانی برای این حساب فعال نیست.');
    const adminParts=path.split('/').filter(Boolean);
    const adminId=adminParts[3]||'';
    const match=adminParts.length>=4&&Number.isSafeInteger(Number(adminId))&&String(Number(adminId))===adminId?[null,adminId,adminParts[4]||'']:null;
    if(request.method==='GET'&&path==='/api/admin/support'){
      const status=String(new URL(request.url).searchParams.get('status')||'all');
      if(!['all','open','answered','closed'].includes(status)) throw new HttpError(400,'فیلتر وضعیت معتبر نیست.');
      const where=status==='all'?'':'WHERE t.status=?';
      const sql=`SELECT t.id,t.user_id,t.subject,t.status,t.created_at,u.username,u.member_id,u.email,
        COALESCE((SELECT message FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1),t.message) AS last_message,
        (SELECT created_at FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_message_at
        FROM support_tickets t JOIN users u ON u.id=t.user_id ${where}
        ORDER BY COALESCE(last_message_at,t.created_at) DESC LIMIT 200`;
      const rows=status==='all'?await env.DB.prepare(sql).all():await env.DB.prepare(sql).bind(status).all();
      const counts=await env.DB.prepare('SELECT status,COUNT(*) AS total FROM support_tickets GROUP BY status').all();
      return json({ok:true,isAdmin:true,tickets:rows.results||[],counts:counts.results||[]});
    }
    if(match&&request.method==='GET'&&!match[2]){
      const id=Number(match[1]);
      const ticket=await env.DB.prepare(`SELECT t.id,t.user_id,t.subject,t.message,t.status,t.created_at,u.username,u.member_id,u.email
        FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?`).bind(id).first();
      if(!ticket) throw new HttpError(404,'تیکت پیدا نشد.');
      const rows=await env.DB.prepare('SELECT id,sender_user_id,sender_role,message,created_at FROM support_messages WHERE ticket_id=? ORDER BY id ASC').bind(id).all();
      const messages=rows.results?.length?rows.results:[{id:0,sender_user_id:ticket.user_id,sender_role:'user',message:ticket.message,created_at:ticket.created_at}];
      return json({ok:true,ticket,messages});
    }
    if(match&&match[2]==='reply'&&request.method==='POST'){
      validateWriteOrigin(request);
      const id=Number(match[1]),body=await readJson(request),message=String(body.message||'').trim();
      if(message.length<1||message.length>2000) throw new HttpError(400,'متن پاسخ باید بین ۱ تا ۲۰۰۰ نویسه باشد.');
      const ticket=await env.DB.prepare('SELECT id,status FROM support_tickets WHERE id=?').bind(id).first();
      if(!ticket) throw new HttpError(404,'تیکت پیدا نشد.');
      if(ticket.status==='closed') throw new HttpError(409,'این تیکت بسته شده است؛ ابتدا وضعیت آن را باز کن.');
      const now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO support_messages(ticket_id,sender_user_id,sender_role,message,created_at) VALUES(?,?,'admin',?,?)").bind(id,user.id,message,now),
        env.DB.prepare("UPDATE support_tickets SET status='answered' WHERE id=?").bind(id)
      ]);
      return json({ok:true});
    }
    if(match&&match[2]==='status'&&request.method==='PATCH'){
      validateWriteOrigin(request);
      const id=Number(match[1]),body=await readJson(request),status=String(body.status||'');
      if(!['open','answered','closed'].includes(status)) throw new HttpError(400,'وضعیت تیکت معتبر نیست.');
      const result=await env.DB.prepare('UPDATE support_tickets SET status=? WHERE id=?').bind(status,id).run();
      if(!result.meta?.changes) throw new HttpError(404,'تیکت پیدا نشد.');
      return json({ok:true,status});
    }
    throw new HttpError(404,'مسیر مدیریت پشتیبانی پیدا نشد.');
  }

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
    const ticketId=Number(inserted.meta?.last_row_id||0);
    if(!ticketId) throw new HttpError(500,'ثبت تیکت انجام نشد.');
    await env.DB.prepare("INSERT INTO support_messages(ticket_id,sender_user_id,sender_role,message,created_at) VALUES(?,?,'user',?,?)").bind(ticketId,user.id,message,nowText).run();
    return json({ok:true,ticketId});
  }

  if(request.method==='GET'&&path==='/api/tickets'){
    const rows=await env.DB.prepare(`SELECT t.id,t.subject,t.status,t.created_at,
      COALESCE((SELECT message FROM support_messages m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1),t.message) AS last_message
      FROM support_tickets t WHERE t.user_id=? ORDER BY t.id DESC LIMIT 30`).bind(user.id).all();
    return json({ok:true,tickets:rows.results||[]});
  }
  const ticketParts=path.split('/').filter(Boolean);
  const ticketIdPart=ticketParts[2]||'';
  const userTicket=ticketParts.length===3&&ticketParts[0]==='api'&&ticketParts[1]==='tickets'&&Number.isSafeInteger(Number(ticketIdPart))&&String(Number(ticketIdPart))===ticketIdPart?[null,ticketIdPart]:null;
  if(userTicket&&request.method==='GET'){
    const id=Number(userTicket[1]);
    const ticket=await env.DB.prepare('SELECT id,subject,status,created_at,message FROM support_tickets WHERE id=? AND user_id=?').bind(id,user.id).first();
    if(!ticket) throw new HttpError(404,'تیکت پیدا نشد.');
    const rows=await env.DB.prepare('SELECT id,sender_role,message,created_at FROM support_messages WHERE ticket_id=? ORDER BY id ASC').bind(id).all();
    return json({ok:true,ticket,messages:rows.results?.length?rows.results:[{id:0,sender_role:'user',message:ticket.message,created_at:ticket.created_at}]});
  }
  if(userTicket&&request.method==='POST'){
    validateWriteOrigin(request);
    const id=Number(userTicket[1]),body=await readJson(request),message=String(body.message||'').trim();
    if(message.length<1||message.length>2000) throw new HttpError(400,'متن پیام باید بین ۱ تا ۲۰۰۰ نویسه باشد.');
    const ticket=await env.DB.prepare('SELECT id,status FROM support_tickets WHERE id=? AND user_id=?').bind(id,user.id).first();
    if(!ticket) throw new HttpError(404,'تیکت پیدا نشد.');
    if(ticket.status==='closed') throw new HttpError(409,'این تیکت بسته شده است و امکان ارسال پیام ندارد.');
    const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO support_messages(ticket_id,sender_user_id,sender_role,message,created_at) VALUES(?,?,'user',?,?)").bind(id,user.id,message,now),
      env.DB.prepare("UPDATE support_tickets SET status='open' WHERE id=?").bind(id)
    ]);
    return json({ok:true});
  }

  if (request.method === 'GET' && path === '/api/tournaments/me') {
    return json({ok:true,...(await myRecurringTournamentData(env.DB,user.id))});
  }

  const gameResponse = await advanceServerGame(env.DB, user, request, path);
  if (gameResponse) return gameResponse;

  if (request.method === 'POST' && path === '/api/tournaments/register') {
    return registerRecurringTournament(env.DB,user,request);
  }

  const roomResponse = await handleRoom(env.DB, request, user, path, env);
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