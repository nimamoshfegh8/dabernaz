import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const origin = new URL(baseUrl).origin;
const runId = randomUUID().slice(0, 8);
const password = 'Dabernaz-QA-2026!';
const accounts = [];
const startingBalance = 5000000;
const roomEconomics = {
  room5000: { price: 5000, linePrize: 20000, fullPrize: 115000, commissionMode: 'revenue_minus_prizes' },
  room10000: { price: 10000, linePrize: 40000, fullPrize: 230000, commissionMode: 'revenue_minus_prizes' },
  room20000: { price: 20000, linePrize: 80000, fullPrize: 460000, commissionMode: 'revenue_minus_prizes' },
  room50000: { price: 50000, linePrize: 200000, fullPrize: 1150000, commissionMode: 'revenue_minus_prizes' },
};

async function request(path, options = {}) {
  const account = options.account;
  const method = options.method || 'GET';
  const headers = { accept: 'application/json' };
  if (account && account.cookie) headers.cookie = account.cookie;
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers.origin = origin;
  }
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(method + ' ' + path + ' returned ' + response.status + ': ' + (data.error || 'no API error message'));
  }
  return data;
}

function checkCard(cards, label, expectedCount) {
  assert.ok(Array.isArray(cards), label + ': no cards array returned');
  assert.equal(cards.length, expectedCount, label + ': wrong number of server-generated cards');
  for (const [cardIndex, card] of cards.entries()) {
    assert.equal(card.length, 3, label + ': card ' + (cardIndex + 1) + ' must have 3 rows');
    const numbers = card.flat().filter(Number.isInteger);
    assert.equal(numbers.length, 15, label + ': card ' + (cardIndex + 1) + ' must contain 15 numbers');
    assert.equal(new Set(numbers).size, 15, label + ': card contains duplicate numbers');
    assert.ok(numbers.every(number => number >= 1 && number <= 90), label + ': number outside 1..90');
    for (const [rowIndex, row] of card.entries()) {
      assert.equal(row.filter(Number.isInteger).length, 5, label + ': row ' + (rowIndex + 1) + ' must contain 5 numbers');
    }
    for (let column = 0; column < 9; column++) {
      const values = card.map(row => row[column]).filter(Number.isInteger);
      assert.ok(values.length >= 1, label + ': empty column ' + (column + 1));
      assert.ok(values.every(number => number >= (column === 0 ? 1 : column * 10) &&
        number <= (column === 8 ? 90 : column * 10 + 9)), label + ': number in wrong column ' + (column + 1));
    }
  }
}

async function accountMe(account) {
  const result = await request('/api/auth/me', { account });
  assert.equal(String(result.user && result.user.id), String(account.id));
  return result.user;
}

async function roomFor(account, roomId) {
  const result = await request('/api/rooms/' + roomId, { account });
  assert.equal(result.ok, true);
  return result.room;
}

async function join(account, roomId, cardsCount = 1) {
  const result = await request('/api/rooms/' + roomId + '/join', {
    account, method: 'POST', body: { cardsCount },
  });
  assert.equal(result.ok, true);
  return result.room;
}

async function leave(account, roomId) {
  const result = await request('/api/rooms/' + roomId + '/leave', {
    account, method: 'POST', body: {},
  });
  assert.equal(result.ok, true);
  return result.room;
}

const health = await request('/api/health');
assert.equal(health.ok, true, 'Cloudflare Pages API health check failed');
assert.equal(health.database, 'D1', 'The smoke test must use a D1 binding');

for (let index = 0; index < 30; index++) {
  const email = 'qa-' + runId + '-' + (index + 1) + '@example.test';
  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'QA Player ' + (index + 1), email, password },
  });
  assert.equal(registered.ok, true);
  assert.ok(registered.user && registered.user.id, 'Registration must return a user id');
  assert.ok(registered.user && registered.user.memberId, 'Registration must return a player id');
  assert.equal(Number(registered.user.balance), 0);
  accounts.push({ email, id: registered.user.id, memberId: registered.user.memberId });
}

// Fund only isolated local CI accounts. This command uses the same local D1 store as
// wrangler pages dev, and never connects to the production D1 database.
const emailPrefix = 'qa-' + runId + '-%@example.test';
execFileSync('wrangler', [
  'd1', 'execute', 'dabernaz-ci', '--local',
  '--persist-to', '.wrangler/test-state',
  '--command', 'UPDATE users SET balance = ' + startingBalance + " WHERE email LIKE '" + emailPrefix + "'",
], { stdio: 'inherit' });

for (const account of accounts) {
  const response = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, accept: 'application/json' },
    body: JSON.stringify({ email: account.email, password }),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, 'login failed for ' + account.email + ': ' + (data.error || ''));
  account.cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(account.cookie, /^dabernaz_session=[0-9a-f]{64}$/i, 'login must return an HttpOnly session cookie');
  assert.equal(Number((await accountMe(account)).balance), startingBalance);
}

const firstFour = accounts.slice(0, 4);
await Promise.all(firstFour.map((account, index) => join(account, 'room5000', index === 0 ? 4 : 1)));
for (const [index, account] of firstFour.entries()) {
  const room = await roomFor(account, 'room5000');
  assert.equal(room.queueCount, 4, 'all four accounts must see the same 4/30 queue count');
  assert.equal(room.capacity, 30);
  assert.deepEqual(room.economics, roomEconomics.room5000);
  assert.equal(room.joined, true);
  checkCard(room.myCards, account.email, index === 0 ? 4 : 1);
  const expected = startingBalance - roomEconomics.room5000.price * (index === 0 ? 4 : 1);
  assert.equal(Number((await accountMe(account)).balance), expected, 'room entry must charge the right amount');
}

await join(firstFour[0], 'room5000', 4);
assert.equal((await roomFor(firstFour[1], 'room5000')).queueCount, 4,
  'repeated join must not create a duplicate seat');
assert.equal(Number((await accountMe(firstFour[0])).balance),
  startingBalance - roomEconomics.room5000.price * 4, 'repeated join must not charge twice');

for (const account of accounts.slice(4)) await join(account, 'room5000', 1);
for (const account of accounts) {
  const room = await roomFor(account, 'room5000');
  assert.equal(room.status, 'playing', 'room should start automatically on player 30');
  assert.equal(room.capacity, 30);
  assert.equal(room.queueCount, 30, 'playing room must report 30 active players');
  assert.equal(room.players.length, 30);
  assert.equal(room.joined, true);
  checkCard(room.myCards, account.email, account === accounts[0] ? 4 : 1);
}

await new Promise(resolve => setTimeout(resolve, 3300));
const afterDraw = await roomFor(accounts[0], 'room5000');
assert.ok(afterDraw.drawCount >= 1, 'the live room should advance when participants poll');
assert.equal(new Set(afterDraw.allCalledNumbers).size, afterDraw.allCalledNumbers.length,
  'drawn numbers must never repeat');

// Complete a deterministic local-only round by setting 1..89 as already called.
// The next server poll calls 90, awards both configured prizes, and closes the round.
const called89 = '[' + Array.from({ length: 89 }, (_, index) => index + 1).join(',') + ']';
const forceEndSql = "UPDATE room_states SET payload = json_set(payload, " +
  "'$.calledNumbers', json('" + called89 + "'), " +
  "'$.nextDrawAt', 1, '$.status', 'playing', " +
  "'$.winners.line', json('null'), '$.winners.full', json('null'), " +
  "'$.linePrizePaid', 0, '$.fullPrizePaid', 0, '$.commissionFinalized', false) " +
  "WHERE room_id = 'room5000'";
execFileSync('wrangler', [
  'd1', 'execute', 'dabernaz-ci', '--local',
  '--persist-to', '.wrangler/test-state',
  '--command', forceEndSql,
], { stdio: 'inherit' });
const finishedRoom = await roomFor(accounts[0], 'room5000');
assert.equal(finishedRoom.status, 'finished');
assert.equal(finishedRoom.finance.finalized, true);
assert.equal(finishedRoom.finance.totalPlayers, 30);
assert.equal(finishedRoom.finance.totalCards, 33);
assert.equal(finishedRoom.finance.grossRevenue, 165000);
assert.equal(finishedRoom.finance.linePrizePaid, roomEconomics.room5000.linePrize);
assert.equal(finishedRoom.finance.fullPrizePaid, roomEconomics.room5000.fullPrize);
assert.equal(finishedRoom.finance.siteCommission,
  165000 - roomEconomics.room5000.linePrize - roomEconomics.room5000.fullPrize);
assert.equal(finishedRoom.finance.siteCommission, 30000, 'commission must be the remaining round revenue');
const commissionRows = execFileSync('wrangler', [
  'd1', 'execute', 'dabernaz-ci', '--local',
  '--persist-to', '.wrangler/test-state',
  '--command', "SELECT COUNT(*) AS rounds, SUM(site_commission) AS total_commission FROM room_finances WHERE room_id = 'room5000'",
], { encoding: 'utf8' });
assert.match(commissionRows, /30000/, 'completed round commission must be saved in the D1 ledger');

for (const roomId of ['room10000', 'room20000', 'room50000']) {
  const economics = roomEconomics[roomId];
  const beforeBalances = [];
  for (const account of firstFour) beforeBalances.push(Number((await accountMe(account)).balance));
  await Promise.all(firstFour.map((account, index) => join(account, roomId, index === 0 ? 4 : 1)));
  for (const [index, account] of firstFour.entries()) {
    const room = await roomFor(account, roomId);
    assert.equal(room.queueCount, 4, roomId + ': all accounts must see 4/30');
    assert.equal(room.capacity, 30);
    assert.deepEqual(room.economics, economics);
    assert.equal(room.joined, true);
    checkCard(room.myCards, account.email, index === 0 ? 4 : 1);
    const expected = beforeBalances[index] - economics.price * (index === 0 ? 4 : 1);
    assert.equal(Number((await accountMe(account)).balance), expected,
      roomId + ': charge must match card count and price');
  }
  for (const account of firstFour) await leave(account, roomId);
  assert.equal((await roomFor(firstFour[0], roomId)).queueCount, 0,
    roomId + ': leaving must clear waiting seats');
  for (const [index, account] of firstFour.entries()) {
    assert.equal(Number((await accountMe(account)).balance), beforeBalances[index],
      roomId + ': leaving must refund all purchased cards');
  }
}

for (const account of accounts) {
  await request('/api/auth/logout', { account, method: 'POST', body: {} });
}

console.log('PASS: 30-player rooms, 1-4 cards, exact entry charges/refunds, line/full payouts, residual site commission ledger, concurrent queue, automatic start, unique draws, and session isolation.');
