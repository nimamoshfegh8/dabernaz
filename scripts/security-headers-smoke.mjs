import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const headers = await readFile(new URL('../_headers', import.meta.url), 'utf8');
const build = await readFile(new URL('../build-pages.mjs', import.meta.url), 'utf8');
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const install = await readFile(new URL('../install.html', import.meta.url), 'utf8');

assert.match(headers, /Content-Security-Policy:/);
const csp = headers.split('\n').find(line => line.trim().startsWith('Content-Security-Policy:')) || '';
for (const directive of [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "connect-src 'self' https://api.github.com",
  "upgrade-insecure-requests"
]) assert.ok(csp.includes(directive), 'CSP missing ' + directive);
assert.doesNotMatch(csp, /unsafe-eval|script-src[^\n]*unsafe-inline/,
  'scripts and eval must not be relaxed by CSP');
assert.match(headers, /X-Content-Type-Options: nosniff/);
assert.match(headers, /X-Frame-Options: DENY/);
assert.match(headers, /Referrer-Policy: strict-origin-when-cross-origin/);
assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/);
assert.match(headers, /Cross-Origin-Resource-Policy: same-origin/);
assert.match(headers, /Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(\)/);
assert.match(build, /'_headers'/, 'Pages build must copy security headers');
assert.doesNotMatch(index, /<script\b(?![^>]*\bsrc=)/i,
  'main application must not add inline scripts which bypass the CSP');
assert.doesNotMatch(install, /<script\b(?![^>]*\bsrc=)/i,
  'install page must not add inline scripts which bypass the CSP');

console.log('Security header and CSP static checks passed.');
