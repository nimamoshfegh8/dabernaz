import { cp, mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const files = [
  'index.html', 'app.js', 'styles.css', 'icon.svg',
  'manifest.webmanifest', 'sw.js', 'sw-register.js',
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of files) await copyFile(path.join(root, file), path.join(out, file));
await cp(path.join(root, 'assets'), path.join(out, 'assets'), { recursive: true });

// Only API requests invoke Pages Functions; ordinary static requests stay on the asset CDN.
const routes = { version: 1, include: ['/api/*'], exclude: [] };
await writeFile(path.join(out, '_routes.json'), `${JSON.stringify(routes, null, 2)}\n`, 'utf8');
console.log(`Dabernaz Pages assets built in ${out}`);
