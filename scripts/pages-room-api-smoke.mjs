import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const workerUrl = (process.env.ROOM_WORKER_URL || 'http://127.0.0.1:8791').replace(/\/$/, '');
const origin = new URL(baseUrl).origin;
const database = process.env.D1_DATABASE || 'dabernaz-local-ci';
const config = process.env.WRANGLER_CONFIG || 'wrangler.pages.ci.toml';
const persist = process.env.WRANGLER_PERSIST || '.wrangler/pages-api-test-state';
const runId = randomUUID().slice(0, 10);
const password = 'Pages-Room-QA-2026!';
const startingBalance = 500000;

function d1(sql) {
  const args = [
    'wrangler', 'd1', 'execute', database,
    '--config', config, '--local', '--persist-to', persist, '--json', '--command', sql
  ];
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  let lastError;
  for (let attempt = 0; attempt < 9; attempt++) {
    try {
      const output = execFileSync('npx', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024
      });
      const parsed = JSON.parse(output.trim());
      const statements = Array.isArray(parsed) ? parsed : [parsed];
      const failed = statements.find(item => item?.success === false);
      if (failed) {
        const detail = JSON.stringify(failed);
        if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(detail)) {
          throw new Error('D1 query failed: ' + detail);
        }
        lastError = new Error('D1 is temporarily locked: ' + detail);
      } else {
        return statements.flatMap(item => item?.results || item?.result?.results || []);
      }
    } catch (error) {
      const detail = [
        error?.message,
        error?.stdout?.toString?.(),
        error?.stderr?.toString?.()
      ].filter(Boolean).join(' ');
      if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(detail)) throw error;
      lastError = error;
    }
    if (attempt < 8) {
      const backoffMs = Math.min(250 * (2 ** attempt), 3000);
      Atomics.wait(waitCell, 0, 0, backoffMs);
    }
  }
  throw new Error(
    'D1 remained locked after 9 bounded attempts; refusing to skip the database assertion. ' +
    (lastError?.message || String(lastError || 'unknown D1 lock error'))
  );
}
function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
async function raw(path, { account, method = 'GET', body, key, headers = {} } = {}) {
  const requestHeaders = { accept: 'application/json', ...headers };
  if (account?.cookie) requestHeaders.cookie = account.cookie;
  if (method !== 'GET' && method !== 'HEAD') {
    requestHeaders['content-type'] = 'application/json';
    requestHeaders.origin = origin;
  }
  if (key) requestHeaders['idempotency-key'] = key;
  const response = await fetch(baseUrl + path, {
    method, headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
async function expect(path, status, options = {}) {
  const { response, data } = await raw(path, options);
  assert.equal(response.status, status, path + ' expected HTTP ' + status + ' but got ' + response.status + ': ' + (data.error || ''));
  return data;
}
async function registerAndLogin(index) {
  const email = 'pages-room-' + runId + '-' + index + '@example.test';
  const registered = await expect('/api/auth/register', 200, {
    method: 'POST', body: { name: 'Pages Room QA ' + index, email, password }
  });
  assert.ok(registered.user?.id, 'register must return a user id');
  const { response, data } = await raw('/api/auth/login', {
    method: 'POST', body: { email, password }
  });
  assert.equal(response.status, 200, 'login must succeed: ' + (data.error || ''));
  const cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(cookie, /^dabernaz_session=[0-9a-f]{64}$/i);
  return { email, id: Number(registered.user.id), memberId: registered.user.memberId, cookie };
}
async function me(account) {
  const result = await expect('/api/auth/me', 200, { account });
  return result.user;
}
async function room(account, roomId) {
  const result = await expect('/api/rooms/' + roomId, 200, { account });
  return result.room;
}
async function waitFor(check, description, timeout = 90000, interval = 250) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await check();
    if (last) return last;
    await delay(interval);
  }
  throw new Error('Timed out waiting for ' + description + '; last=' + JSON.stringify(last));
}
async function join(account, roomId, cardsCount, key = randomUUID()) {
  const result = await raw('/api/rooms/' + roomId + '/join', {
    account,
    method: 'POST',
    key,
    headers: account.extraHeaders || {},
    body: { cardsCount, purchaseConfirmed: true }
  });
  assert.equal(result.response.status, 200,
    roomId + ' join must succeed: ' + (result.data.error || ''));
  assert.ok(Number.isSafeInteger(Number(result.data.purchase?.amount)) && Number(result.data.purchase.amount) > 0,
    roomId + ' purchase amount must be a positive server-calculated integer');
  return { ...result.data, key };
}

const accounts = [];
for (let index = 1; index <= 4; index++) accounts.push(await registerAndLogin(index));
const emailList = accounts.map(account => sqlString(account.email)).join(',');
d1("UPDATE users SET balance=" + startingBalance + " WHERE email IN (" + emailList + ");");
for (const account of accounts) assert.equal(Number((await me(account)).balance), startingBalance);

const appliedMigrationNames = d1("SELECT name FROM d1_migrations ORDER BY id").map((row) => row.name);
assert.deepEqual(appliedMigrationNames, [
  "0000_core_schema.sql",
  "0001_room_rounds_financial_queue.sql",
  "0002_wallet_request_idempotency.sql",
  "0003_tournament_entry_idempotency.sql",
  "0004_transaction_round_link.sql",
], "Wrangler must track every applied D1 migration exactly once");

const healthCheck = await raw('/api/health');
assert.equal(healthCheck.response.status, 200, 'Pages health must verify the live Worker and Durable Object: ' + JSON.stringify(healthCheck.data));
assert.equal(healthCheck.data.schema, 'v4');
assert.equal(healthCheck.data.roomCoordinator?.ready, true);
assert.equal(healthCheck.data.roomCoordinator?.durableObject?.ready, true);
assert.equal(healthCheck.data.roomCoordinator?.transactionRoundLink, true);

const rateSince = Math.floor(Date.now() / 1000) - 600;
const rateEmail = sqlString(accounts[0].email);
const rateState = d1("SELECT " +
  "(SELECT COUNT(*) FROM auth_attempts WHERE email=" + rateEmail + " AND attempted_at>" + rateSince + ") AS email_count," +
  "(SELECT ip FROM auth_attempts WHERE email=" + rateEmail + " ORDER BY attempted_at DESC LIMIT 1) AS test_ip," +
  "(SELECT COUNT(*) FROM auth_attempts WHERE ip=(SELECT ip FROM auth_attempts WHERE email=" + rateEmail + " ORDER BY attempted_at DESC LIMIT 1) AND email=" + rateEmail + " AND attempted_at>" + rateSince + ") AS pair_count," +
  "(SELECT COUNT(*) FROM auth_attempts WHERE ip=(SELECT ip FROM auth_attempts WHERE email=" + rateEmail + " ORDER BY attempted_at DESC LIMIT 1) AND attempted_at>" + rateSince + ") AS ip_count")[0];
const rateAllowed = Math.max(0, Math.min(
  20,
  10 - Number(rateState.email_count || 0),
  10 - Number(rateState.pair_count || 0),
  30 - Number(rateState.ip_count || 0)
));
const concurrentAuthAttempts = await Promise.all(Array.from({ length: 20 }, () => raw('/api/auth/register', {
  method: 'POST',
  body: { name: 'Rate Limit Duplicate', email: accounts[0].email, password }
})));
assert.ok(concurrentAuthAttempts.every(item => [409, 429].includes(item.response.status)),
  'concurrent duplicate registrations must be either rejected as existing accounts or rate-limited');
assert.equal(concurrentAuthAttempts.filter(item => item.response.status === 409).length, rateAllowed,
  'atomic rate limiter must admit only the remaining attempts below all thresholds');
assert.equal(concurrentAuthAttempts.filter(item => item.response.status === 429).length, 20 - rateAllowed,
  'concurrent authentication attempts beyond the thresholds must receive HTTP 429');
const rateCountAfter = Number(d1("SELECT COUNT(*) AS n FROM auth_attempts WHERE email=" + rateEmail + " AND attempted_at>" + rateSince)[0].n);
assert.equal(rateCountAfter, Number(rateState.email_count || 0) + rateAllowed,
  'only admitted authentication attempts may be recorded');

// No session and an unconfirmed request must never charge or create a purchase.
await expect('/api/rooms/room5000/join', 401, {
  method: 'POST', key: randomUUID(), body: { cardsCount: 1, purchaseConfirmed: true }
});
const before = Number((await me(accounts[0])).balance);
await expect('/api/rooms/room5000/join', 400, {
  account: accounts[0], method: 'POST', key: randomUUID(), body: { cardsCount: 1 }
});
assert.equal(Number((await me(accounts[0])).balance), before);

// A forged user-id header is stripped by Pages Functions; ownership comes from the session.
accounts[0].extraHeaders = { 'x-dabernaz-user-id': String(accounts[1].id) };
const firstKey = randomUUID();
const firstBody = { cardsCount: 1, purchaseConfirmed: true };
const first = await raw('/api/rooms/room5000/join', {
  account: accounts[0], method: 'POST', key: firstKey,
  headers: accounts[0].extraHeaders, body: firstBody
});
assert.equal(first.response.status, 200, 'first room purchase: ' + (first.data.error || ''));
assert.equal(first.data.purchase.amount, 5000);
assert.equal(first.data.purchase.replayed, false);
const replay = await raw('/api/rooms/room5000/join', { account: accounts[0], method: 'POST', key: firstKey, body: firstBody });
assert.equal(replay.response.status, 200);
assert.equal(replay.data.purchase.id, first.data.purchase.id);
assert.equal(replay.data.purchase.replayed, true);
await expect('/api/rooms/room5000/join', 409, {
  account: accounts[0], method: 'POST', key: firstKey,
  body: { cardsCount: 2, purchaseConfirmed: true }
});
assert.equal(Number((await me(accounts[0])).balance), startingBalance - 5000,
  'idempotent replay must debit exactly once');
assert.equal(Number((await me(accounts[1])).balance), startingBalance,
  'a forged identity header must not debit another account');

const second = await join(accounts[1], 'room5000', 1);
assert.equal(second.purchase.amount, 5000);
assert.equal(second.room.playerCount, 2);
const addFour = await join(accounts[0], 'room5000', 4);
assert.equal(addFour.purchase.amount, 20000);
assert.equal(addFour.room.playerCount, 2);
assert.equal(addFour.room.cardCount, 6);
assert.equal(addFour.room.myCards.length, 5);
const afterFive = Number((await me(accounts[0])).balance);
await expect('/api/rooms/room5000/join', 409, {
  account: accounts[0], method: 'POST', key: randomUUID(),
  body: { cardsCount: 1, purchaseConfirmed: true }
});
assert.equal(Number((await me(accounts[0])).balance), afterFive,
  'the sixth card must be rejected without charging');

const round1 = d1("SELECT id,sequence,status,registration_deadline FROM room_rounds WHERE room_id='room5000' ORDER BY sequence");
assert.equal(round1.length, 1);
const round1Id = round1[0].id;
assert.equal(Number(d1("SELECT COUNT(*) AS count FROM transactions WHERE type='room_entry' AND round_id=" + sqlString(round1Id))[0].count), 3,
  'all initial and additional room purchases must reference the exact round');

// Repeated room GETs are read-only: they cannot draw a number or change round state.
const readBefore = d1("SELECT status,called_numbers_json,next_draw_at FROM room_rounds WHERE id=" + sqlString(round1Id))[0];
for (let index = 0; index < 8; index++) await room(accounts[index % 2], 'room5000');
const readAfter = d1("SELECT status,called_numbers_json,next_draw_at FROM room_rounds WHERE id=" + sqlString(round1Id))[0];
assert.deepEqual(readAfter, readBefore, 'GET room snapshots must not advance draws or mutate status');

await waitFor(async () => {
  const row = d1("SELECT status FROM room_rounds WHERE id=" + sqlString(round1Id))[0];
  return row?.status === 'playing' ? row : null;
}, 'the two-player 150-second-equivalent registration window (accelerated to 15s in CI)', 45000);

// Two other independent sessions register while the first game is playing.
const queuedOne = await join(accounts[2], 'room5000', 1);
assert.equal(queuedOne.purchase.amount, 5000);
assert.equal(queuedOne.room.status, 'playing');
const queuedTwo = await join(accounts[3], 'room5000', 1);
assert.equal(queuedTwo.purchase.amount, 5000);
assert.equal(queuedTwo.room.status, 'playing');
const roundRows = d1("SELECT id,sequence,status,registration_deadline FROM room_rounds WHERE room_id='room5000' ORDER BY sequence");
assert.equal(roundRows.length, 2);
const round2 = roundRows[1];
assert.equal(roundRows[0].status, 'playing');
assert.equal(round2.status, 'registration_open');
assert.notEqual(roundRows[0].id, round2.id);

// Expire only the queued round. The coordinator must move it to waiting_for_room,
// never start a second game while the first is still playing.
d1("UPDATE room_rounds SET registration_deadline=1 WHERE id=" + sqlString(round2.id));
const reconcile = await fetch(workerUrl + '/rooms/room5000/reconcile', { method: 'POST' });
assert.equal(reconcile.status, 200, 'internal local reconcile should succeed');
let queuedState = d1("SELECT status FROM room_rounds WHERE id=" + sqlString(round2.id))[0]?.status;
assert.equal(queuedState, 'waiting_for_room');
assert.equal(d1("SELECT COUNT(*) AS count FROM room_rounds WHERE room_id='room5000' AND status='playing'")[0].count, 1,
  'only one round may be playing in a room');

await waitFor(async () => {
  const row = d1("SELECT status FROM room_rounds WHERE id=" + sqlString(round1Id))[0];
  return row?.status === 'completed' ? row : null;
}, 'first round to complete through Durable Object alarms without browser-triggered draws', 120000, 300);
assert.equal(d1("SELECT COUNT(*) AS count FROM room_rounds WHERE room_id='room5000' AND status='playing'")[0].count, 1);
await waitFor(async () => {
  const row = d1("SELECT status FROM room_rounds WHERE id=" + sqlString(round2.id))[0];
  return row?.status === 'playing' ? row : null;
}, 'queued second round to start after first round completion', 15000, 150);

const finance = d1("SELECT total_players,total_cards,gross_revenue,line_prize_paid,full_prize_paid,site_commission FROM room_finances WHERE round_id=" + sqlString(round1Id))[0];
assert.ok(finance, 'completed round must have a durable finance summary');
assert.equal(Number(finance.total_players), 2);
assert.equal(Number(finance.total_cards), 6);
assert.equal(Number(finance.gross_revenue), 30000);
assert.equal(Number(finance.line_prize_paid) + Number(finance.full_prize_paid) + Number(finance.site_commission), 30000,
  'line, full, and commission shares must reconcile exactly');
assert.equal(Number(finance.line_prize_paid), 3000);
assert.equal(Number(finance.full_prize_paid), 22500);
assert.equal(Number(finance.site_commission), 4500);
const payoutCount = Number(d1("SELECT COUNT(*) AS count FROM room_payouts WHERE round_id=" + sqlString(round1Id))[0].count);
const payoutTransactionCount = Number(d1("SELECT COUNT(*) AS count FROM transactions WHERE type='room_prize' AND round_id=" + sqlString(round1Id))[0].count);
assert.equal(payoutTransactionCount, payoutCount,
  'every room payout must have exactly one transaction with the same round_id');
assert.equal(d1("SELECT COUNT(*) AS count FROM room_player_stats WHERE round_id=" + sqlString(round1Id))[0].count, 2);
assert.equal(d1("SELECT COUNT(*) AS count FROM room_payouts WHERE round_id=" + sqlString(round1Id))[0].count > 0, true);

// The separate one-player room must be fully refunded, exactly once, by its alarm.
const refundBefore = Number((await me(accounts[0])).balance);
const singlePurchase = await join(accounts[0], 'room10000', 1);
assert.equal(singlePurchase.purchase.amount, 10000);
assert.equal(singlePurchase.purchase.amount, 10000);
const refundRound = d1("SELECT id FROM room_rounds WHERE room_id='room10000' ORDER BY sequence DESC LIMIT 1")[0].id;
await waitFor(async () => {
  const row = d1("SELECT status FROM room_rounds WHERE id=" + sqlString(refundRound))[0];
  return row?.status === 'refunded' ? row : null;
}, 'single-player cancellation and refund', 45000);
assert.equal(Number((await me(accounts[0])).balance), refundBefore,
  'single-player cancellation must return the full amount');
const refundCount = d1("SELECT COUNT(*) AS count FROM room_refunds WHERE round_id=" + sqlString(refundRound))[0].count;
assert.equal(Number(refundCount), 1, 'the valid purchase must be refunded once');
assert.equal(Number(d1("SELECT COUNT(*) AS count FROM transactions WHERE type='room_refund' AND round_id=" + sqlString(refundRound))[0].count), 1,
  'the refund transaction must reference its exact round');
const refundLedgerCount = d1("SELECT COUNT(*) AS count FROM financial_ledger WHERE operation='room_refund' AND reference_id IN (SELECT id FROM room_purchases WHERE round_id=" + sqlString(refundRound) + ")")[0].count;
assert.equal(Number(refundLedgerCount), 1, 'refund must be represented once in the financial ledger');

await fetch(workerUrl + '/rooms/room10000/reconcile', { method: 'POST' });
await fetch(workerUrl + '/rooms/room10000/reconcile', { method: 'POST' });
assert.equal(Number(d1("SELECT COUNT(*) AS count FROM room_refunds WHERE round_id=" + sqlString(refundRound))[0].count), 1,
  'reconcile retries must not duplicate refunds');

// Recurring tournament entry uses the same exactly-once financial contract.
const tournamentEventId = 'ci-simple-' + runId;
const tournamentNow = new Date().toISOString();
const tournamentScheduled = new Date(Date.now() + 60 * 60 * 1000).toISOString();
d1("INSERT INTO tournament_events(id,tournament_type,scheduled_at,registration_opens_at,status,registered_count,capacity,prize_pool,min_players,stage,created_at,updated_at) VALUES(" +
  [tournamentEventId, 'simple', tournamentScheduled, tournamentNow, 'registration', 0, 30, 0, 5, 'registration', tournamentNow, tournamentNow].map(sqlString).join(',') + ")");
d1("UPDATE users SET bingo_coins=500 WHERE id IN (" + accounts[0].id + "," + accounts[1].id + ")");
const tournamentKey = 'tournament-ci-' + runId;
const tournamentBody = { type: 'simple' };
const tournamentFirst = await raw('/api/tournaments/register', {
  account: accounts[0], method: 'POST', key: tournamentKey, body: tournamentBody
});
assert.equal(tournamentFirst.response.status, 200, 'first recurring tournament entry must succeed: ' + (tournamentFirst.data.error || ''));
assert.equal(tournamentFirst.data.replayed, false);
assert.equal(tournamentFirst.data.event_id, tournamentEventId);
const tournamentReplay = await raw('/api/tournaments/register', {
  account: accounts[0], method: 'POST', key: tournamentKey, body: tournamentBody
});
assert.equal(tournamentReplay.response.status, 200);
assert.equal(tournamentReplay.data.replayed, true);
assert.equal(tournamentReplay.data.event_id, tournamentEventId);
await expect('/api/tournaments/register', 409, {
  account: accounts[0], method: 'POST', key: tournamentKey, body: { type: 'bingo' }
});
assert.equal(Number(d1("SELECT bingo_coins FROM users WHERE id=" + accounts[0].id)[0].bingo_coins), 480,
  'same tournament key must debit the entry fee exactly once');
assert.equal(Number(d1("SELECT COUNT(*) AS count FROM tournament_event_entries WHERE event_id=" + sqlString(tournamentEventId) + " AND user_id=" + accounts[0].id)[0].count), 1);
assert.equal(Number(d1("SELECT COUNT(*) AS count FROM tournament_entry_idempotency WHERE user_id=" + accounts[0].id + " AND idempotency_key=" + sqlString(tournamentKey))[0].count), 1);
assert.equal(Number(d1("SELECT COUNT(*) AS count FROM financial_ledger WHERE operation='tournament_entry' AND user_id=" + accounts[0].id + " AND reference_id=" + sqlString(tournamentEventId + ':' + accounts[0].id))[0].count), 1);

const concurrentTournamentKey = 'tournament-concurrent-' + runId;
const concurrentTournamentRequests = await Promise.all(Array.from({ length: 5 }, () => raw('/api/tournaments/register', {
  account: accounts[1], method: 'POST', key: concurrentTournamentKey, body: tournamentBody
})));
assert.ok(concurrentTournamentRequests.every(item => item.response.status === 200),
  'concurrent retries with one tournament key must resolve to the original successful entry');
assert.equal(new Set(concurrentTournamentRequests.map(item => item.data.event_id)).size, 1);
assert.equal(Number(d1("SELECT bingo_coins FROM users WHERE id=" + accounts[1].id)[0].bingo_coins), 480,
  'five concurrent requests with one key must debit only one entry fee');
assert.equal(Number(d1("SELECT COUNT(*) AS count FROM tournament_event_entries WHERE event_id=" + sqlString(tournamentEventId) + " AND user_id=" + accounts[1].id)[0].count), 1);
assert.equal(Number(d1("SELECT COUNT(*) AS count FROM tournament_entry_idempotency WHERE user_id=" + accounts[1].id + " AND idempotency_key=" + sqlString(concurrentTournamentKey))[0].count), 1);
await expect('/api/tournaments/register', 409, {
  account: accounts[1], method: 'POST', key: 'tournament-new-key-' + runId, body: tournamentBody
});
assert.equal(Number(d1("SELECT bingo_coins FROM users WHERE id=" + accounts[1].id)[0].bingo_coins), 480,
  'a different key must not bypass the one-entry-per-event rule');

console.log('Pages + Worker API integration passed: independent authenticated accounts, spoofed identity rejection, idempotent purchases, five-card cap, read-only GET, 150s CI deadline, queued rounds, one-playing invariant, alarm-driven game completion, exact 10/75/15 finance, and exactly-once one-player refund.');
