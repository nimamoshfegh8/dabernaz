import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dabernaz-node-disabled-'));
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const baseUrl = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    DABERNAZ_DATA_DIR: dataDir,
    COOKIE_SECURE: 'false'
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('Node fallback exited early: ' + stderr);
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.status === 503) return response;
    } catch (_) {}
    await delay(100);
  }
  throw new Error('Node fallback did not enter its disabled state: ' + stderr);
}

try {
  const health = await waitForHealth();
  const healthBody = await health.json();
  assert.equal(healthBody.code, 'NODE_FALLBACK_DISABLED');

  const register = await fetch(baseUrl + '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({
      name: 'Disabled QA',
      email: 'disabled@example.invalid',
      password: 'Disabled-QA-password-2026!'
    })
  });
  assert.equal(register.status, 503, 'production Node fallback must not create isolated JSON accounts');

  const roomGet = await fetch(baseUrl + '/api/rooms/room5000');
  assert.equal(roomGet.status, 503, 'production Node fallback must not expose legacy room GET transitions');

  const gameStart = await fetch(baseUrl + '/api/games/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ gameType: 'tic' })
  });
  assert.equal(gameStart.status, 503, 'production Node fallback must not accept game mutations');

  console.log('Node fallback guard passed: all API paths fail closed outside isolated test mode.');
} finally {
  child.kill('SIGTERM');
  await delay(100);
  await rm(dataDir, { recursive: true, force: true });
}
