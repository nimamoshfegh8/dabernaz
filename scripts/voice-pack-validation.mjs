import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'assets', 'voice', 'sage-woman.json');
const audioPath = path.join(root, 'assets', 'voice', 'sage-woman.mp3');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.provider, 'kenerate-sage-woman');
assert.equal(manifest.voice, 'Sage Woman');
assert.equal(manifest.language, 'fa-IR');
assert.equal(Number(manifest.requiredNumbers), 90);
assert.ok(manifest.numbers && typeof manifest.numbers === 'object' && !Array.isArray(manifest.numbers));

function numberToPersianWords(number) {
  const value = Math.trunc(Number(number));
  const units = ['صفر','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه'];
  const teens = ['ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'];
  const tens = ['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'];
  if (value < 10) return units[value];
  if (value < 20) return teens[value - 10];
  const ten = Math.floor(value / 10);
  const one = value % 10;
  return one ? tens[ten] + ' و ' + units[one] : tens[ten];
}

const keys = Object.keys(manifest.numbers);
if (manifest.configured !== true) {
  assert.equal(manifest.configured, false, 'pending voice pack must be explicitly disabled');
  assert.equal(keys.length, 0, 'an incomplete package must not expose partial number clips');
  console.log('Sage Woman voice pack is safely pending: complete audio and 90 clips are not installed yet.');
} else {
  assert.equal(keys.length, 90, 'configured voice package must contain exactly 90 clips');
  assert.ok(existsSync(audioPath), 'configured voice package must include sage-woman.mp3');
  assert.ok(statSync(audioPath).size >= 15000, 'voice MP3 appears truncated or too small');
  let previousEnd = 0;
  for (let number = 1; number <= 90; number++) {
    const clip = manifest.numbers[String(number)];
    const start = Number(clip?.start);
    const duration = Number(clip?.duration);
    assert.ok(clip, 'missing number ' + number);
    assert.ok(Number.isFinite(start) && start >= 0, 'invalid start for number ' + number);
    assert.ok(Number.isFinite(duration) && duration > 0, 'invalid duration for number ' + number);
    assert.ok(start >= previousEnd - 0.03, 'clips overlap or are out of order at number ' + number);
    assert.equal(String(clip.text || '').trim(), numberToPersianWords(number), 'wrong spoken text for number ' + number);
    previousEnd = start + duration;
  }
  console.log('Sage Woman voice pack metadata passed validation for all 90 numbers.');
}
