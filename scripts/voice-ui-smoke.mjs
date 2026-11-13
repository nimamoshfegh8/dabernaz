import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, index, sw, swRegister] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../sw-register.js', import.meta.url), 'utf8')
]);

const settingsStart = app.indexOf('function renderSettings()');
const settingsEnd = app.indexOf('\nfunction ', settingsStart + 12);
assert.ok(settingsStart >= 0 && settingsEnd > settingsStart, 'settings renderer must exist');
const settings = app.slice(settingsStart, settingsEnd);
const testButton = settings.match(/<button[^>]*data-action="test-number-voice"[^>]*>/);
assert.ok(testButton, 'number voice test button must render');
assert.doesNotMatch(testButton[0], /\sdisabled(?:\s|>|=)/i,
  'number voice test must never be disabled just because Sage Woman is missing');

const testActionStart = app.indexOf("else if (action === 'test-number-voice')");
const testActionEnd = app.indexOf("\n  else if (action === 'enable-room-audio')", testActionStart);
assert.ok(testActionStart >= 0 && testActionEnd > testActionStart, 'number test action must exist');
const testAction = app.slice(testActionStart, testActionEnd);
assert.match(testAction, /speakPersianNumberFallback\(42\)/,
  'test must start device speech directly when Sage Woman pack is unavailable');
assert.match(testAction, /playPersianNumberAudio\(42,\s*\{\s*allowFallback:false\s*\}\)/,
  'test must use the chosen Sage Woman audio when the complete pack is ready');
assert.match(testAction, /state\.settings\.sounds\s*=\s*true/);
assert.match(testAction, /state\.settings\.voiceNumbers\s*=\s*true/);

const fallbackStart = app.indexOf('function speakPersianNumberFallback(number)');
const fallbackEnd = app.indexOf('\nfunction unlockPersianAudio()', fallbackStart);
assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart, 'device speech fallback must exist');
const fallback = app.slice(fallbackStart, fallbackEnd);
assert.match(fallback, /window\.speechSynthesis\.speak\(utterance\)/);
assert.match(fallback, /numberToPersianWords\(value\)\.replace\(\/ و \/g, ' '\)/,
  'fallback must say only the number without the spoken conjunction');
assert.match(fallback, /utterance\.lang\s*=.*fa-IR/);

assert.match(index, /app\.js\?v=4\.17\.0/);
assert.match(sw, /dabernaz-shell-v19/);
assert.match(sw, /app\.js\?v=4\.17\.0/);
assert.match(swRegister, /sw\.js\?v=10/);

console.log('Persian voice UI smoke test passed: test button enabled, direct Android gesture path, Sage Woman preference, number-only Persian wording, and fresh mobile cache versions.');
