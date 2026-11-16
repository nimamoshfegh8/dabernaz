import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const [index, manifestText, sw, register, build, packageText, installHtml, installJs, entryJs, css, workflow, redirects] = await Promise.all([
  read('index.html'), read('manifest.webmanifest'), read('sw.js'), read('sw-register.js'),
  read('build-pages.mjs'), read('package.json'), read('install.html'), read('install.js'),
  read('pwa-entry.js'), read('pwa-install.css'), read('.github/workflows/android-apk.yml'), read('_redirects')
]);
const manifest = JSON.parse(manifestText);
assert.equal(manifest.name, 'Dabernaz Game Club');
assert.equal(manifest.short_name, 'Dabernaz');
assert.equal(manifest.start_url, './');
assert.equal(manifest.scope, './');
assert.equal(manifest.display, 'standalone');
const iconBySize = size => manifest.icons.some(icon => icon.sizes === size && icon.type === 'image/png');
assert.ok(iconBySize('192x192'), 'manifest must declare a 192px PNG icon');
assert.ok(iconBySize('512x512'), 'manifest must declare a 512px PNG icon');
assert.ok(manifest.icons.some(icon => icon.purpose?.split(' ').includes('maskable')), 'manifest must include a maskable icon');
for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
  const path = new URL(name, root);
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', name + ' must be PNG');
  assert.ok((await stat(path)).size > 1000, name + ' must not be empty');
}
assert.match(index, /rel="manifest"/);
assert.match(index, /apple-touch-icon/);
assert.match(index, /pwa-entry\.js/);
assert.match(index, /pwa-install\.css/);
assert.match(sw, /dabernaz-shell-v30/);
for (const asset of ['./install.html', './install.js', './pwa-entry.js', './pwa-install.css', './icon-192.png', './icon-512.png', './icon-maskable-512.png']) {
  assert.ok(sw.includes(asset), 'service worker must precache ' + asset);
  assert.ok(build.includes("'" + asset.slice(2) + "'") || build.includes("'" + asset + "'"), 'Pages build must copy ' + asset);
}
assert.match(sw, /install\.html/);
assert.match(register, /sw\.js\?v=20/);
assert.match(installHtml, /pwaInstallButton/);
assert.match(installHtml, /iosInstructions/);
assert.match(installJs, /beforeinstallprompt/);
assert.match(installJs, /appinstalled/);
assert.match(installJs, /releases\/latest/);
assert.match(installJs, /response\.status === 404/);
assert.match(installJs, /\.\/download\/Dabernaz\.apk/);
assert.match(redirects, /\/download\/Dabernaz\.apk https:\/\/github\.com\/nimamoshfegh8\/dabernaz\/releases\/latest\/download\/Dabernaz\.apk 302/);
assert.match(entryJs, /install\.html/);
assert.match(css, /pwa-install-entry/);
assert.match(workflow, /ANDROID_SIGNING_KEYSTORE_BASE64/);
assert.match(workflow, /apksigner" verify/);
assert.match(workflow, /Dabernaz\.apk/);
assert.match(workflow, /permissions:\n  contents: read/);
assert.match(workflow, /publish-release:[\s\S]*?contents: write/);
assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
assert.doesNotMatch(workflow, /\n    env:\n      ANDROID_KEYSTORE_PASSWORD:/);
assert.match(packageText, /pwa-install-smoke\.mjs/);
console.log('PWA install and APK release smoke checks passed.');
