import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const tempDir = await mkdtemp(path.join(tmpdir(), 'dabernaz-php-api-'));
let phpServer = null;

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('PHP fallback test server did not start in time.');
}

try {
  await copyFile(path.join(root, '..', 'api.php'), path.join(tempDir, 'api.php'));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  phpServer = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', tempDir], {
    cwd: tempDir,
    stdio: 'ignore',
    env: { ...process.env, DABERNAZ_TEST_MODE: '1' },
  });

  const apiUrl = path => {
    const url = new URL('/api.php', baseUrl);
    url.searchParams.set('path', path);
    return url;
  };
  const request = (path, options = {}) => fetch(apiUrl(path), {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.method && options.method !== 'GET'
        ? { 'content-type': 'application/json', origin: baseUrl }
        : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  await waitForServer(apiUrl('/api/health'));
  const health = await request('/api/health');
  assert.equal(health.status, 200, 'PHP fallback health endpoint must respond');

  const email = `php-qa-${Date.now()}@example.test`;
  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'PHP QA Player', email, password: 'PHP-QA-password-2026!' },
  });
  assert.equal(registered.status, 200, 'PHP fallback registration must work');
  const registration = await registered.json();
  assert.equal(registration.ok, true);
  const setCookie = registered.headers.get('set-cookie') || '';
  const cookie = setCookie.match(/dabernaz_php_session=[^;]+/)?.[0];
  assert.ok(cookie, 'PHP fallback must set a session cookie');

  const beforeResponse = await request('/api/auth/me', { cookie });
  assert.equal(beforeResponse.status, 200);
  const before = await beforeResponse.json();
  assert.equal(before.user.stats.gamesPlayed, 0);
  assert.equal(before.user.stats.wins, 0);
  assert.equal(before.user.stats.points, 0);

  const forgedResult = await request('/api/games/result', {
    method: 'POST',
    cookie,
    body: { won: true },
  });
  assert.equal(forgedResult.status, 405,
    'PHP fallback must reject client-submitted mini-game outcomes');

  const afterResponse = await request('/api/auth/me', { cookie });
  const after = await afterResponse.json();
  assert.equal(after.user.stats.gamesPlayed, 0,
    'rejected self-reported results must not increment played games');
  assert.equal(after.user.stats.wins, 0,
    'rejected self-reported results must not increment wins');
  assert.equal(after.user.stats.points, 0,
    'rejected self-reported results must not increment points');

  // Each request deliberately omits the PHP session cookie. The limiter must
  // therefore be enforced by the server using the client IP + normalized email,
  // not by a browser session that an attacker can rotate.
  const bruteForceEmail = 'php-rate-limit@example.test';
  for (let attempt = 0; attempt < 10; attempt++) {
    const failedLogin = await request('/api/auth/login', {
      method: 'POST',
      body: { email: bruteForceEmail, password: 'wrong-password-2026!' },
    });
    assert.equal(failedLogin.status, 401, 'the first ten login attempts should reach credential verification');
  }
  const blockedLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: bruteForceEmail, password: 'wrong-password-2026!' },
  });
  assert.equal(blockedLogin.status, 429,
    'PHP fallback must rate limit repeated login attempts even when the caller rotates sessions');

  console.log('PHP fallback smoke test passed: sessions work, forged game results are rejected, and IP/email login throttling is enforced.');
} finally {
  if (phpServer && !phpServer.killed) phpServer.kill('SIGTERM');
  await rm(tempDir, { recursive: true, force: true });
}
