import { cp, mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const files = [
  'index.html', 'install.html', 'app.js', 'install.js', 'pwa-entry.js', 'styles.css',
  'pwa-install.css', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'icon-maskable-512.png', 'manifest.webmanifest', 'sw.js', 'sw-register.js',
  '_headers', '_redirects',
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of files) await copyFile(path.join(root, file), path.join(out, file));
await cp(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });
await cp(path.join(root, 'admin'), path.join(out, 'admin'), { recursive: true });

const routes = { version: 1, include: ['/api/*'], exclude: [] };
await writeFile(path.join(out, '_routes.json'), JSON.stringify(routes, null, 2) + '\n', 'utf8');
console.log('Dabernaz Pages assets built in ' + out);
