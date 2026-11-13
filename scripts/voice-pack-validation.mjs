import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = path.join(root, 'assets', 'voice', 'sage-woman.json');
const audioPath = path.join(root, 'assets', 'voice', 'sage-woman.mp3');
const allowPending = process.argv.includes('--allow-pending');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.provider, 'kenerate-sage-woman');
assert.equal(manifest.voice, 'Sage Woman');
assert.equal(manifest.language, 'fa-IR');
assert.equal(Number(manifest.requiredNumbers), 90);

function numberToSpokenPersian(number) {
  const value = Math.trunc(Number(number));
  const units = ['صفر','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه'];
  const teens = ['ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'];
  const tens = ['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'];
  if (value < 10) return units[value];
  if (value < 20) return teens[value - 10];
  const ten = Math.floor(value / 10);
  const one = value % 10;
  return (tens[ten] + (one ? ' ' + units[one] : '')).trim();
}

const keys = Object.keys(manifest.numbers || {});
const packageReady = manifest.configured === true &&
  keys.length === 90 && existsSync(audioPath);

if (!packageReady) {
  const message = 'INCOMPLETE RELEASE: Sage Woman audio package is missing or incomplete. ' +
    'The release requires assets/voice/sage-woman.mp3 and a manifest containing all 90 validated clips.';
  if (allowPending) {
    console.warn('WARNING: ' + message);
    console.warn('This local override is for source-code testing only; it does not make the release audio-complete.');
  } else {
    console.error('::error::' + message);
    console.error(message);
    process.exitCode = 1;
  }
} else {
  assert.ok(statSync(audioPath).size >= 15000, 'voice MP3 appears truncated or too small');
  assert.ok(manifest.numbers && typeof manifest.numbers === 'object' && !Array.isArray(manifest.numbers));
  let previousEnd = 0;
  for (let number = 1; number <= 90; number++) {
    const clip = manifest.numbers[String(number)];
    const start = Number(clip?.start);
    const duration = Number(clip?.duration);
    assert.ok(clip, 'missing number ' + number);
    assert.ok(Number.isFinite(start) && start >= 0, 'invalid start for number ' + number);
    assert.ok(Number.isFinite(duration) && duration > 0, 'invalid duration for number ' + number);
    assert.ok(start >= previousEnd - 0.03, 'clips overlap or are out of order at number ' + number);
    assert.equal(String(clip.text || '').trim(), numberToSpokenPersian(number), 'wrong spoken text for number ' + number);
    previousEnd = start + duration;
  }
  const audioDuration = Number(manifest.audioDurationSeconds);
  assert.ok(Number.isFinite(audioDuration) && audioDuration > 0, 'manifest must declare decoded MP3 duration in seconds');
  assert.ok(audioDuration + 0.1 >= previousEnd, 'one or more clips exceed the MP3 duration');
  console.log('Sage Woman voice package is complete: MP3 present and all 90 clips validated.');
}
