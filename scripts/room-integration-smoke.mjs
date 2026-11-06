import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const origin = new URL(baseUrl).origin;
const runId = randomUUID().slice(0, 8);
const password = 'Dabernaz-QA-2026!';
const accounts = [];

async function request(path, { account, method = 'GET', body } = {}) {
  const headers = { accept: 'application/json' };
  if (account?.cookie) headers.cookie = account.cookie;
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers.origin = origin;
  }
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${data.error || 'no API error message'}`);
  }
  return data;
}

function checkCard(cards, label) {
  assert.ok(Array.isArray(cards) && cards.length >= 1, `${label}: no server-generated cards returned`);
  for (const [cardIndex, card] of cards.entries()) {
    assert.equal(card.length, 3, `${label}: card ${cardIndex + 1} must have 3 rows`);
    const numbers = card.flat().filter(Number.isInteger);
    assert.equal(numbers.length, 15, `${label}: card ${cardIndex + 1} must contain 15 numbers`);
    assert.equal(new Set(numbers).size, 15, `${label}: card ${cardIndex + 1} contains duplicate numbers`);
    assert.ok(numbers.every(number => number >= 1 && number <= 90), `${label}: number outside 1..90`);
    for (const [rowIndex, row] of card.entries()) {
      assert.equal(row.filter(Number.isInteger).length, 5, `${label}: row ${rowIndex + 1} must contain 5 numbers`);
    }
    for (let column = 0; column < 9; column++) {
      const columnValues = card.map(row => row[column]).filter(Number.isInteger);
      assert.ok(columnValues.length >= 1, `${label}: empty column ${column + 1}`);
      assert.ok(columnValues.every(number => number >= (column === 0 ? 1 : column * 10) && number <= (column === 8 ? 90 : column * 10 + 9)),
        `${label}: number in wrong bingo column ${column + 1}`);
    }
  }
}

async function roomFor(account, roomId) {
  const result = await request(`/api/rooms/${roomId}`, { account });
  assert.equal(result.ok, true);
  return result.room;
}

async function join(account, roomId) {
  const result = await request(`/api/rooms/${roomId}/join`, {
    account, method: 'POST', body: { cardsCount: 1 },
  });
  assert.equal(result.ok, true);
  return result.room;
}

async function leave(account, roomId) {
  const result = await request(`/api/rooms/${roomId}/leave`, {
    account, method: 'POST', body: {},
  });
  assert.equal(result.ok, true);
  return result.room;
}

const health = await request('/api/health');
assert.equal(health.ok, true, 'Cloudflare Pages API health check failed');
assert.equal(health.database, 'D1', 'The smoke test must use a D1 binding');

for (let index = 0; index < 20; index++) {
  const email = `qa-${runId}-${index + 1}@example.test`;
  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: { name: `QA Player ${index + 1}`, email, password },
  });
  assert.equal(registered.ok, true);
  assert.ok(registered.user?.id, 'Registration must return a user id');
  assert.ok(registered.user?.memberId, 'Registration must return a player id');
  assert.equal(Number(registered.user.balance), 0);
  const setCookie = registered.headers?.['set-cookie'];
  // Fetch response headers are not included in the JSON API payload; obtain the
  // actual cookie from the registration response via the helper below.
  accounts.push({ email, id: registered.user.id, memberId: registered.user.memberId });
}

async function registerWithCookie(index) {
  const account = accounts[index];
  const response = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, accept: 'application/json' },
    body: JSON.stringify({ email: account.email, password }),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `login failed for ${account.email}: ${data.error || ''}`);
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';', 1)[0];
  assert.match(cookie, /^dabernaz_session=[0-9a-f]{64}$/i, 'login must return an HttpOnly session cookie');
  account.cookie = cookie;
  return account;
}

for (let index = 0; index < accounts.length; index++) await registerWithCookie(index);

// Four independent sessions joining at once must see one shared queue, not four private 1/20 queues.
const firstFour = accounts.slice(0, 4);
await Promise.all(firstFour.map(account => join(account, 'room5000')));
for (const account of firstFour) {
  const room = await roomFor(account, 'room5000');
  assert.equal(room.queueCount, 4, 'all four accounts must see the same 4/20 queue count');
  assert.equal(room.capacity, 20);
  assert.equal(room.joined, true);
  checkCard(room.myCards, account.email);
}

// A repeated join by the same account must be idempotent.
await join(firstFour[0], 'room5000');
assert.equal((await roomFor(firstFour[1], 'room5000')).queueCount, 4, 'repeated join must not create a duplicate seat');

// Fill the room to exactly 20 distinct accounts. The twentieth seat must start the game.
for (const account of accounts.slice(4)) await join(account, 'room5000');
for (const account of accounts) {
  const room = await roomFor(account, 'room5000');
  assert.equal(room.status, 'playing', 'room should start automatically on player 20');
  assert.equal(room.queueCount, 20, 'playing room must report 20 active players');
  assert.equal(room.players.length, 20);
  assert.equal(room.joined, true);
  checkCard(room.myCards, account.email);
}

// The draw is server-driven on room polling and numbers must not repeat.
await new Promise(resolve => setTimeout(resolve, 3300));
const afterDraw = await roomFor(accounts[0], 'room5000');
assert.ok(afterDraw.drawCount >= 1, 'the live room should advance when participants poll');
assert.equal(new Set(afterDraw.allCalledNumbers).size, afterDraw.allCalledNumbers.length,
  'drawn numbers must never repeat');

// Every price tier must use the same shared queue and support leave.
for (const roomId of ['room10000', 'room20000', 'room50000']) {
  await Promise.all(firstFour.map(account => join(account, roomId)));
  for (const account of firstFour) {
    const room = await roomFor(account, roomId);
    assert.equal(room.queueCount, 4, `${roomId}: all accounts must see 4/20`);
    assert.equal(room.joined, true);
    checkCard(room.myCards, account.email);
  }
  for (const account of firstFour) await leave(account, roomId);
  assert.equal((await roomFor(firstFour[0], roomId)).queueCount, 0,
    `${roomId}: leaving must clear waiting seats`);
}

// Verify authenticated account lookup remains session-specific, then close all test sessions.
for (const account of accounts) {
  const me = await request('/api/auth/me', { account });
  assert.equal(String(me.user?.id), String(account.id));
  await request('/api/auth/logout', { account, method: 'POST', body: {} });
}

console.log('PASS: D1 API health, 20 registrations/logins, four concurrent joins, shared 4/20 queue in every tier, idempotent join, card validation, automatic 20/20 start, unique server draw, leave, and session isolation.');
