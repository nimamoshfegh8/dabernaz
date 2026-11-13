import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dabernaz-node-room-'));
const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const baseUrl = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'test',
    DABERNAZ_DATA_DIR: dataDir,
    DABERNAZ_DRAW_INTERVAL_MS: '60000',
    DABERNAZ_TEST_REGISTRATION_WINDOW_MS: '500',
    COOKIE_SECURE: 'false'
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let serverError = '';
child.stderr.on('data', chunk => { serverError += chunk.toString(); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error('Node fallback exited early: ' + serverError);
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
    } catch (_) {}
    await delay(150);
  }
  throw new Error('Node fallback did not start: ' + serverError);
}

async function request(route, { method = 'GET', cookie, body } = {}) {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers.origin = baseUrl;
  }
  const response = await fetch(baseUrl + route, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

try {
  await waitForHealth();
  const accounts = [];
  for (let index = 0; index < 5; index++) {
    const email = 'fallback-' + index + '-' + Date.now() + '@example.test';
    const { response, data } = await request('/api/auth/register', {
      method: 'POST',
      body: { name: 'Fallback QA ' + index, email, password: 'Dabernaz-QA-2026!' }
    });
    assert.equal(response.status, 200, data.error || 'register failed');
    const cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0];
    assert.match(cookie, /^dabernaz_session=/);
    accounts.push({ email, cookie, id: data.user.id });
  }

  const first = await request('/api/rooms/room5000/join', {
    method: 'POST', cookie: accounts[0].cookie, body: { cardsCount: 3 }
  });
  assert.equal(first.response.status, 200, first.data.error || '');
  const firstRoom = first.data.room;
  assert.equal(firstRoom.capacity, null);
  assert.equal(firstRoom.registrationWindowMs, 500);
  assert.equal(firstRoom.minPlayersToStart, 2);
  assert.equal(firstRoom.maxCardsPerPlayer, 5);
  assert.equal(firstRoom.playerCount, 1);
  assert.equal(firstRoom.cardCount, 3);
  const fixedDeadline = firstRoom.registrationDeadline;
  assert.equal(fixedDeadline - firstRoom.registrationStartedAt, 500);

  const addTwo = await request('/api/rooms/room5000/join', {
    method: 'POST', cookie: accounts[0].cookie, body: { cardsCount: 2 }
  });
  assert.equal(addTwo.response.status, 200);
  assert.equal(addTwo.data.room.myCards.length, 5);
  assert.equal(addTwo.data.room.registrationDeadline, fixedDeadline);

  const sixth = await request('/api/rooms/room5000/join', {
    method: 'POST', cookie: accounts[0].cookie, body: { cardsCount: 1 }
  });
  assert.equal(sixth.response.status, 409, 'sixth card must be rejected');
  assert.equal((await request('/api/rooms/room5000', { cookie: accounts[0].cookie })).data.room.cardCount, 5);

  for (const account of accounts.slice(1)) {
    const joined = await request('/api/rooms/room5000/join', {
      method: 'POST', cookie: account.cookie, body: { cardsCount: 1 }
    });
    assert.equal(joined.response.status, 200, joined.data.error || '');
    assert.equal(joined.data.room.registrationDeadline, fixedDeadline, 'later joins must not extend the timer');
  }

  const beforeLogout = await request('/api/rooms/room5000', { cookie: accounts[1].cookie });
  assert.equal(beforeLogout.data.room.playerCount, 5);
  assert.equal(beforeLogout.data.room.cardCount, 9);
  const logout = await request('/api/auth/logout', {
    method: 'POST', cookie: accounts[0].cookie, body: {}
  });
  assert.equal(logout.response.status, 200);
  const afterLogout = await request('/api/rooms/room5000', { cookie: accounts[1].cookie });
  assert.equal(afterLogout.data.room.playerCount, 5, 'logout must retain paid queue membership');
  assert.equal(afterLogout.data.room.cardCount, 9, 'logout must retain queued cards');

  const leave = await request('/api/rooms/room5000/leave', {
    method: 'POST', cookie: accounts[1].cookie, body: {}
  });
  assert.equal(leave.response.status, 409, 'purchased entries cannot be cancelled');

  // Expire the first round's fixed timer in isolated test storage. The server
  // starts it only after the deadline and only when at least two people joined.
  await delay(600);
  const started = await request('/api/rooms/room5000', { cookie: accounts[1].cookie });
  assert.equal(started.data.room.status, 'playing');
  assert.equal(started.data.room.capacity, null);
  assert.equal(started.data.room.playerCount, 5);
  assert.equal(started.data.room.cardCount, 9);
  assert.equal(started.data.room.myCards.length, 1);

  // Re-authenticate the account used above after verifying that logout
  // did not remove its purchased entry from the other players' room view.
  const relogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: accounts[0].email, password: 'Dabernaz-QA-2026!' }
  });
  assert.equal(relogin.response.status, 200, relogin.data.error || 'relogin failed');
  accounts[0].cookie = (relogin.response.headers.get('set-cookie') || '').split(';', 1)[0];

  // A single-player room must be cancelled when its fixed timer expires.
  const solo = await request('/api/rooms/room10000/join', {
    method: 'POST', cookie: accounts[0].cookie, body: { cardsCount: 1 }
  });
  assert.equal(solo.response.status, 200);
  await delay(600);
  const cancelled = await request('/api/rooms/room10000', { cookie: accounts[0].cookie });
  assert.equal(cancelled.data.room.status, 'waiting');
  assert.equal(cancelled.data.room.playerCount, 0);
  assert.equal(cancelled.data.room.cardCount, 0);
  assert.equal(cancelled.data.room.joined, false);

  // The next purchase starts a fresh timer and a second player is enough to start.
  const fresh = await request('/api/rooms/room10000/join', {
    method: 'POST', cookie: accounts[0].cookie, body: { cardsCount: 1 }
  });
  assert.equal(fresh.response.status, 200);
  const second = await request('/api/rooms/room10000/join', {
    method: 'POST', cookie: accounts[1].cookie, body: { cardsCount: 1 }
  });
  assert.equal(second.response.status, 200);
  await delay(600);
  const startedWithTwo = await request('/api/rooms/room10000', { cookie: accounts[1].cookie });
  assert.equal(startedWithTwo.data.room.status, 'playing');
  assert.equal(startedWithTwo.data.room.playerCount, 2);

  console.log('Node fallback room parity smoke test passed.');
} finally {
  child.kill('SIGTERM');
  await delay(100);
  await rm(dataDir, { recursive: true, force: true });
}
