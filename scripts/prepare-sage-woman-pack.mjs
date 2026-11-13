import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceArg = process.argv.indexOf('--source');
const sourceDir = sourceArg >= 0 && process.argv[sourceArg + 1]
  ? path.resolve(process.argv[sourceArg + 1])
  : path.resolve(process.cwd(), 'kenerate-exports');
const allowPartial = process.argv.includes('--allow-partial');
const targetDir = path.join(root, 'assets', 'voice', 'sage-woman');

const units = ['صفر','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه'];
const teens = ['ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'];
const tens = ['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'];
function numberText(number) {
  if (number < 10) return units[number];
  if (number < 20) return teens[number - 10];
  const ten = Math.floor(number / 10);
  const one = number % 10;
  return (tens[ten] + (one ? ' و ' + units[one] : '')).trim();
}
function isMp3(bytes) {
  const id3 = bytes.subarray(0, 3).toString('ascii') === 'ID3';
  const frame = bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return id3 || frame;
}

await mkdir(targetDir, { recursive: true });
const files = new Set(await readdir(sourceDir).catch(() => []));
const entries = {};
const missing = [];

for (let number = 1; number <= 90; number++) {
  const filename = String(number).padStart(3, '0') + '.mp3';
  const sourcePath = path.join(sourceDir, filename);
  const targetPath = path.join(targetDir, filename);
  let chosenPath = null;

  if (files.has(filename)) {
    chosenPath = sourcePath;
    const bytes = await readFile(sourcePath);
    if (bytes.length < 500 || bytes.length > 2_000_000 || !isMp3(bytes)) {
      throw new Error('Invalid MP3 for number ' + number + ': ' + sourcePath);
    }
    await cp(sourcePath, targetPath);
  } else {
    try {
      const existing = await readFile(targetPath);
      if (existing.length >= 500 && existing.length <= 2_000_000 && isMp3(existing)) chosenPath = targetPath;
    } catch (_) {}
  }

  if (!chosenPath) {
    missing.push(filename);
    continue;
  }
  entries[String(number)] = { file: filename, text: numberText(number) };
}

const manifest = {
  version: 3,
  provider: 'kenerate-sage-woman',
  voice: 'Sage Woman',
  language: 'fa-IR',
  configured: missing.length === 0,
  requiredNumbers: 90,
  numbers: entries
};
await writeFile(path.join(root, 'assets', 'voice', 'sage-woman.json'),
  JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('Saved ' + Object.keys(entries).length + '/90 validated Sage Woman clips.');
if (missing.length) {
  console.error('Missing files: ' + missing.join(', '));
  if (!allowPartial) {
    console.error('Add the missing numbered MP3 files, then run this command again. Use --allow-partial only to update a test manifest.');
    process.exitCode = 1;
  }
} else {
  console.log('Complete 90-number manifest generated. Run node scripts/voice-pack-validation.mjs before release.');
}
