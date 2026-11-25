import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';

const writes = [];
const user = {
  id: 42,
  username: 'Read Only QA',
  member_id: '404242',
  email: 'readonly@example.invalid',
  balance: 100000,
  bingo_coins: 500,
  created_at: '2026-11-18T00:00:00.000Z',
  games_played: 0,
  wins: 0,
  points: 0,
  password_hash: 'not-used-by-this-test'
};

function createStatement(sql) {
  let params = [];
  return {
    bind(...values) { params = values; return this; },
    async first() {
      if (/MAX\(version\)/i.test(sql)) return { version: 3 };
      if (/sqlite_master/i.test(sql)) return { total: 11 };
      if (/FROM auth_sessions\s+s\s+JOIN users/i.test(sql)) return user;
      if (/SELECT bingo_coins FROM users/i.test(sql)) return { bingo_coins: user.bingo_coins };
      if (/SELECT 1 AS ok/i.test(sql)) return { ok: 1 };
      return null;
    },
    async all() { return { results: [] }; },
    async run() {
      writes.push({ kind: 'run', sql, params });
      return { success: true, meta: { changes: 1 } };
    }
  };
}

const DB = {
  prepare(sql) { return createStatement(String(sql)); },
  async batch(statements) {
    writes.push({ kind: 'batch', count: statements.length });
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
};

const ROOM_COORDINATOR = {
  async fetch(request) {
    if (request.method !== 'GET') writes.push({ kind: 'room-service-write', method: request.method });
    return new Response(JSON.stringify({
      ok: true,
      room: { id: 'room5000', status: 'waiting', joined: false, playerCount: 0 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
};

const env = { DB, ROOM_COORDINATOR };
const cookie = 'dabernaz_session=' + 'a'.repeat(64);
const paths = [
  '/api/health',
  '/api/auth/me',
  '/api/tournaments',
  '/api/tournaments/me',
  '/api/games/active?gameType=tic',
  '/api/rooms/room5000',
  '/api/rooms/history'
];

for (const path of paths) {
  const response = await onRequest({
    request: new Request('https://preview.example.invalid' + path, {
      method: 'GET',
      headers: { cookie }
    }),
    env
  });
  assert.ok(response.status < 500, path + ' should remain a readable GET route');
  await response.arrayBuffer();
}

assert.deepEqual(writes, [],
  'GET health/auth/tournament/game/room/history routes must not write D1 or invoke room-service mutations');

const healthResponse = await onRequest({
  request: new Request('https://preview.example.invalid/api/health', { method: 'GET' }),
  env
});
const healthBody = await healthResponse.json();
assert.equal(healthBody.schema, 'v3', 'API health must report the complete D1 schema');
assert.equal(healthBody.walletRequests?.idempotency, true, 'wallet idempotency table must be observable');
assert.equal(healthBody.tournamentEntries?.idempotency, true, 'tournament idempotency table must be observable');
assert.equal(healthBody.readiness, 'ready', 'mocked Pages and room service bindings should report ready');
assert.deepEqual(writes, [], 'health readiness checks must remain read-only');

console.log('API read-only contract passed: GET routes caused no D1 batch/run or room-service write.');
