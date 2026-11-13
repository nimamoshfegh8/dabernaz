import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'assets', 'voice', 'sage-woman.json');
const audioDir = path.join(root, 'assets', 'voice', 'sage-woman');
const allowPending = process.argv.includes('--allow-pending');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

assert.equal(Number(manifest.version), 3);
assert.equal(manifest.provider, 'kenerate-sage-woman');
assert.equal(manifest.voice, 'Sage Woman');
assert.equal(manifest.language, 'fa-IR');
assert.equal(Number(manifest.requiredNumbers), 90);
assert.ok(manifest.numbers && typeof manifest.numbers === 'object' && !Array.isArray(manifest.numbers));

function numberToSpokenPersian(number) {
  const value = Math.trunc(Number(number));
  const units = ['صفر','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه'];
  const teens = ['ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'];
  const tens = ['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'];
  if (value < 10) return units[value];
  if (value < 20) return teens[value - 10];
  const ten = Math.floor(value / 10);
  const one = value % 10;
  return (tens[ten] + (one ? ' و ' + units[one] : '')).trim();
}

function assertMp3(filePath, number) {
  assert.ok(existsSync(filePath), 'missing Sage Woman MP3 for number ' + number);
  const size = statSync(filePath).size;
  assert.ok(size >= 500 && size <= 2_000_000, 'invalid file size for number ' + number + ': ' + size);
  const bytes = readFileSync(filePath);
  const hasId3 = bytes.subarray(0, 3).toString('ascii') === 'ID3';
  const hasMpegFrame = bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  assert.ok(hasId3 || hasMpegFrame, 'file is not a recognizable MP3 for number ' + number);
}

const missing = [];
const declared = Object.keys(manifest.numbers);
for (let number = 1; number <= 90; number++) {
  const key = String(number);
  const filename = String(number).padStart(3, '0') + '.mp3';
  const clip = manifest.numbers[key];
  if (!clip) {
    missing.push(filename);
    continue;
  }
  assert.equal(clip.file, filename, 'wrong filename for number ' + number);
  assert.equal(String(clip.text || '').trim(), numberToSpokenPersian(number), 'wrong script text for number ' + number);
  assertMp3(path.join(audioDir, filename), number);
}
for (const key of declared) {
  assert.ok(Number.isInteger(Number(key)) && Number(key) >= 1 && Number(key) <= 90,
    'manifest contains an out-of-range number key: ' + key);
}
const complete = missing.length === 0 && declared.length === 90 && manifest.configured === true;
if (!complete) {
  const message = 'INCOMPLETE RELEASE: Sage Woman voice pack has ' + (90 - missing.length) +
    '/90 verified MP3 clips. Missing: ' + missing.join(', ');
  if (allowPending) {
    console.warn('WARNING: ' + message);
    console.warn('The local partial-pack override never marks this as a complete release.');
  } else {
    console.error('::error::' + message);
    console.error(message);
    process.exitCode = 1;
  }
} else {
  console.log('Sage Woman package complete: all 90 independent MP3 clips and Persian texts validated.');
}
