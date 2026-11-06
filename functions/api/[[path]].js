/* Dabernaz Cloudflare Pages Function: authentication, D1 accounts and live Daberna rooms. */
const CAPACITY = 30;
const ROOM_ECONOMICS = Object.freeze({
  room5000: { price: 5000, linePrize: 20000, fullPrize: 115000, commission: 15000 },
  room10000: { price: 10000, linePrize: 40000, fullPrize: 230000, commission: 30000 },
  room20000: { price: 20000, linePrize: 80000, fullPrize: 460000, commission: 60000 },
  room50000: { price: 50000, linePrize: 200000, fullPrize: 1150000, commission: 150000 },
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
  ];
  for (const sql of statements) await db.prepare(sql).run();
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
      const session = await db.prepare('SELECT user_id FROM auth_sessions WHERE token_hash = ?').bind(hash).first();
      if (session) {
        const userId = Number(session.user_id);
        for (const roomId of ROOM_IDS) {
          await withRoomLock(db, roomId, async () => {
            const room = await loadRoom(db, roomId);
            if (room.status === 'waiting') {
              room.queue = room.queue.filter((id) => Number(id) !== userId);
              delete room.queuedCards[String(userId)];
              delete room.cardCounts[String(userId)];
              await saveRoom(db, room);
            }
          }).catch(() => {});
        }
      }
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
    id: roomId,
    status: 'waiting',
    queue: [],
    cardCounts: {},
    queuedCards: {},
    entryPayments: {},
    players: [],
    calledNumbers: [],
    winners: { line: null, full: null },
    startedAt: null,
    finishedAt: null,
    nextDrawAt: null,
    updatedAt: Date.now(),
  };
}

async function loadRoom(db, roomId) {
  const row = await db.prepare('SELECT payload FROM room_states WHERE room_id = ?').bind(roomId).first();
  if (row?.payload) {
    try {
      const room = JSON.parse(row.payload);
      room.entryPayments ||= {};
      room.cardCounts ||= {};
      room.queuedCards ||= {};
      return room;
    }
    catch (error) {
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
    } else {
      statements.push(db.prepare('UPDATE users SET bingo_coins = bingo_coins + ? WHERE id = ?').bind(award.amount, award.userId));
      statements.push(db.prepare(`INSERT INTO transactions (user_id, type, amount, description, created_at)
        VALUES (?, 'bingo_coin', ?, ?, ?)`).bind(award.userId, award.amount, award.description, award.createdAt));
    }
  }
  // D1 batch is transactional: room winner state and its BGC rewards commit together.
  await db.batch(statements);
}

async function withRoomLock(db, roomId, callback) {
  const token = randomToken(16);
  let acquired = false;
  for (let attempt = 0; attempt < 16; attempt++) {
    // Refresh the clock on each attempt. A timestamp captured before waiting can
    // otherwise prevent acquisition even after a previous lease has expired.
    const now = Date.now();
    const lock = await db.prepare(`INSERT INTO room_locks (room_id, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
      WHERE room_locks.expires_at < ?
      RETURNING token`)
      .bind(roomId, token, now + 10000, now).first();
    if (lock?.token === token) { acquired = true; break; }
    // Room writes are serialized in D1. Wait longer for neighboring joins
    // instead of rejecting valid players during a short burst of activity.
    await new Promise((resolve) => setTimeout(resolve, Math.min(45 + attempt * 25, 200)));
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
  const ids = room.queue.map(Number);
  if (ids.length < CAPACITY) return false;
  const placeholders = ids.map(() => '?').join(',');
  const query = await db.prepare(`SELECT id, username, member_id FROM users WHERE id IN (${placeholders})`).bind(...ids).all();
  const byId = new Map((query.results || []).map((row) => [Number(row.id), row]));
  const players = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    players.push({
      userId: id,
      name: row.username,
      memberId: String(row.member_id || ''),
      cards: room.queuedCards[String(id)] || [makeCard()],
    });
  }
  if (players.length < CAPACITY) throw new HttpError(409, 'تعداد حساب‌های معتبر اتاق به ۳۰ نفر نرسیده است.');
  room.players = players;
  room.queue = [];
  room.queuedCards = {};
  room.cardCounts = {};
  room.status = 'playing';
  room.calledNumbers = [];
  room.winners = { line: null, full: null };
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

    if (!room.winners.line) {
      outerLine: for (const player of room.players) {
        for (const card of player.cards) {
          if (lineComplete(card, called)) {
            room.winners.line = { name: player.name, memberId: player.memberId, number, at: Math.floor(Date.now() / 1000) };
            const prize = ROOM_ECONOMICS[room.id]?.linePrize || 0;
            if (prize) awards.push({ kind:'balance', userId: player.userId, amount: prize, description: 'جایزه یک خط دبرنا', createdAt: new Date().toISOString() });
            break outerLine;
          }
        }
      }
    }
    if (!room.winners.full) {
      outerFull: for (const player of room.players) {
        for (const card of player.cards) {
          if (fullComplete(card, called)) {
            room.winners.full = { name: player.name, memberId: player.memberId, number, at: Math.floor(Date.now() / 1000) };
            const prize = ROOM_ECONOMICS[room.id]?.fullPrize || 0;
            if (prize) awards.push({ kind:'balance', userId: player.userId, amount: prize, description: 'جایزه دبرنای کامل', createdAt: new Date().toISOString() });
            break outerFull;
          }
        }
      }
    }
    room.nextDrawAt += DRAW_INTERVAL_MS;
    changed = true;
    if ((room.winners.line && room.winners.full) || room.calledNumbers.length >= 90) {
      room.status = 'finished';
      room.finishedAt = Math.floor(Date.now() / 1000);
      room.nextDrawAt = null;
    }
  }
  return { changed, awards };
}

async function publicRoom(db, room, userId) {
  const me = room.players.find((player) => Number(player.userId) === Number(userId));
  const queued = room.queue.some((id) => Number(id) === Number(userId));
  const account = await db.prepare('SELECT bingo_coins FROM users WHERE id = ?').bind(userId).first();
  return {
    id: room.id,
    status: room.status,
    capacity: CAPACITY,
    economics: ROOM_ECONOMICS[room.id] || null,
    queueCount: room.status === 'waiting' ? room.queue.length : room.players.length,
    players: room.players.map((player) => ({ name: player.name, memberId: player.memberId })),
    calledNumbers: room.calledNumbers.slice(-15),
    allCalledNumbers: room.calledNumbers,
    drawCount: room.calledNumbers.length,
    latestNumber: room.calledNumbers.length ? room.calledNumbers[room.calledNumbers.length - 1] : null,
    winners: room.winners,
    myCards: me?.cards || (queued ? (room.queuedCards[String(userId)] || []) : []),
    joined: queued || !!me,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    myBingoCoins: Number(account?.bingo_coins) || 0,
    myCoinTransactions: await coinHistory(db, userId),
  };
}

async function handleRoom(db, request, user, path) {
  const match = path.match(/^\/api\/rooms\/(room5000|room10000|room20000|room50000)(?:\/(join|leave))?$/);
  if (!match) return null;
  const [, roomId, action = ''] = match;
  const userId = Number(user.id);

  if (request.method === 'GET' && !action) {
    let room = await loadRoom(db, roomId);
    if (room.status === 'playing' && room.nextDrawAt && room.nextDrawAt <= Date.now()) {
      await withRoomLock(db, roomId, async () => {
        room = await loadRoom(db, roomId);
        const advanced = advanceRoom(room);
        if (advanced.changed) await saveRoom(db, room, advanced.awards);
      }).catch((error) => { if (!(error instanceof HttpError && error.status === 409)) throw error; });
      room = await loadRoom(db, roomId);
    }
    return json({ ok: true, room: await publicRoom(db, room, userId) });
  }

  if (request.method === 'POST' && action === 'join') {
    validateWriteOrigin(request);
    const body = await readJson(request);
    const cardsCount = 1;
    const result = await withRoomLock(db, roomId, async () => {
      let room = await loadRoom(db, roomId);
      const economics = ROOM_ECONOMICS[roomId];
      if (!economics) throw new HttpError(500, 'تنظیمات مالی این اتاق پیدا نشد.');
      const advanced = advanceRoom(room);
      if (advanced.changed) await saveRoom(db, room, advanced.awards);
      if (room.status === 'finished') room = newRoom(roomId);
      if (room.status === 'playing') return { conflict: true, room: await publicRoom(db, room, userId) };
      if (room.queue.some((id) => Number(id) === userId)) return { room: await publicRoom(db, room, userId) };
      if (room.queue.length >= CAPACITY) throw new HttpError(409, 'ظرفیت این اتاق تکمیل شده است.');

      const account = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(userId).first();
      if ((Number(account?.balance) || 0) < economics.price) throw new HttpError(400, 'موجودی کیف پول برای خرید این کارت کافی نیست.');

      room.cardCounts[String(userId)] = cardsCount;
      room.queuedCards[String(userId)] = [makeCard()];
      room.entryPayments[String(userId)] = economics.price;
      room.queue.push(userId);
      if (room.queue.length >= CAPACITY) await startRoom(db, room);
      room.updatedAt = Date.now();
      await db.batch([
        db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').bind(economics.price, userId),
        db.prepare(`INSERT INTO transactions (user_id, type, amount, description, created_at)
          VALUES (?, 'room_entry', ?, ?, ?)`).bind(userId, -economics.price, 'خرید کارت دبرنا', new Date().toISOString()),
        db.prepare(`INSERT INTO room_states (room_id, payload, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(room_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
          .bind(room.id, JSON.stringify(room), room.updatedAt),
      ]);
      return { room: await publicRoom(db, room, userId) };
    });
    if (result.conflict) return json({ error: 'این سانس در حال اجراست. بعد از پایان وارد سانس بعدی شو.', room: result.room }, 409);
    return json({ ok: true, room: result.room });
  }

  if (request.method === 'POST' && action === 'leave') {
    validateWriteOrigin(request);
    const result = await withRoomLock(db, roomId, async () => {
      const room = await loadRoom(db, roomId);
      if (room.status === 'waiting') {
        const payment = Number(room.entryPayments?.[String(userId)] || 0);
        room.queue = room.queue.filter((id) => Number(id) !== userId);
        delete room.queuedCards[String(userId)];
        delete room.cardCounts[String(userId)];
        if (room.entryPayments) delete room.entryPayments[String(userId)];
        if (payment > 0) {
          await saveRoom(db, room, [{ kind:'balance', userId, amount:payment, description:'بازگشت هزینه کارت دبرنا', createdAt:new Date().toISOString() }]);
        } else await saveRoom(db, room);
      }
      return await publicRoom(db, room, userId);
    });
    return json({ ok: true, room: result });
  }
  return json({ error: 'روش درخواست برای این مسیر پشتیبانی نمی‌شود.' }, 405);
}

async function routeRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return json({ error: 'مسیر API پیدا نشد.' }, 404);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    'allow': 'GET, POST, PATCH, OPTIONS',
    'cache-control': 'no-store',
  } });
  if (!env.DB) return json({ ok: false, error: 'اتصال D1 تنظیم نشده است؛ در Pages Settings یک D1 binding با نام DB اضافه کن.' }, 503);
  await ensureSchema(env.DB);

  if (request.method === 'GET' && path === '/api/health') {
    return json({ ok: true, service: 'dabernaz', backend: 'cloudflare-pages-functions', database: 'D1', mode: 'ready' });
  }

  const authResponse = await handleAuth(env.DB, request, path);
  if (authResponse) return authResponse;

  const isProtected = path === '/api/profile' || path === '/api/games/result' || /^\/api\/rooms\//.test(path);
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

  if (request.method === 'POST' && path === '/api/games/result') {
    validateWriteOrigin(request);
    const body = await readJson(request);
    if (typeof body.won !== 'boolean') throw new HttpError(400, 'نتیجه مسابقه معتبر نیست.');
    const won = body.won ? 1 : 0;
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET games_played = games_played + 1,
        wins = wins + ?, points = points + ? WHERE id = ?`).bind(won, won ? 10 : 0, user.id),
      env.DB.prepare(`INSERT INTO game_results (user_id, game_type, result, prize, bingo_coins_earned)
        VALUES (?, 'mini-game', ?, 0, 0)`).bind(user.id, won ? 'win' : 'loss'),
    ]);
    const stats = await env.DB.prepare('SELECT games_played, wins, points FROM users WHERE id = ?').bind(user.id).first();
    return json({ ok: true, stats: {
      gamesPlayed: Number(stats?.games_played) || 0,
      wins: Number(stats?.wins) || 0,
      points: Number(stats?.points) || 0,
    } });
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
    return json({ error: message, ...(status >= 500 ? { requestId } : {}), ...(error?.extra || {}) }, status);
  }
}