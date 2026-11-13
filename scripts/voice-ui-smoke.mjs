import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const [app, index, sw, swRegister, android, manifestText, voiceScript, validator, importer, sampleStat] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../sw-register.js', import.meta.url), 'utf8'),
  readFile(new URL('../android/app/src/main/java/app/dabernaz/club/MainActivity.java', import.meta.url), 'utf8'),
  readFile(new URL('../assets/voice/sage-woman.json', import.meta.url), 'utf8'),
  readFile(new URL('../docs/kenerate-90-number-script.txt', import.meta.url), 'utf8'),
  readFile(new URL('./voice-pack-validation.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./prepare-sage-woman-pack.mjs', import.meta.url), 'utf8'),
  stat(new URL('../assets/voice/sage-woman/042.mp3', import.meta.url))
]);

const manifest = JSON.parse(manifestText);
const scriptLines = voiceScript.trim().split(/\r?\n/);

assert.match(app, /const PersianAudioManager = \{/);
assert.match(app, /playEffectTone\(\)/);
assert.match(app, /previewSample\(options = \{\}\)/);
assert.match(app, /loadPersianNumberAudio\(number\)/);
assert.match(app, /source\.start\(0\)/);
assert.match(app, /availableSageWomanNumbers\.size === 90/);
assert.match(app, /voicePackReady = manifest\.configured === true/);
assert.match(app, /PersianAudioManager\.speak\(value\)/);
assert.match(app, /PersianAudioManager\.previewSample\(\{ fromGesture: true \}\)/);
assert.match(app, /بستهٔ کامل Sage Woman آماده نیست/);
assert.doesNotMatch(app, /speechSynthesis|SpeechSynthesisUtterance|DabernazNativeTTS|sage-woman\.mp3/);

const testActionStart = app.indexOf("else if (action === 'test-number-voice')");
const roomActionStart = app.indexOf("else if (action === 'enable-room-audio')", testActionStart);
assert.ok(testActionStart >= 0 && roomActionStart > testActionStart);
assert.match(app.slice(testActionStart, roomActionStart), /PersianAudioManager\.previewSample/);

const roomSpeakStart = app.indexOf('function speakRoomNumber(number, room)');
const roomSpeakEnd = app.indexOf('\nasync function toggleSetting(key)', roomSpeakStart);
const roomSpeak = app.slice(roomSpeakStart, roomSpeakEnd);
assert.match(roomSpeak, /PersianAudioManager\.speak\(value\)/);
assert.doesNotMatch(roomSpeak, /settingEnabled\('sounds'\)/);
assert.match(roomSpeak, /spokenRoomAnnouncementKeys\.add\(announcementKey\)/);
assert.match(roomSpeak, /roomSpeechRetryAt\.set\(announcementKey,\s*Date\.now\(\)\s*\+\s*7000\)/);

assert.doesNotMatch(android, /TextToSpeech|DabernazNativeTTS|JavascriptInterface/);
assert.match(android, /START_URL/);
assert.match(index, /app\.js\?v=4\.19\.0/);
assert.match(sw, /dabernaz-shell-v21/);
assert.match(sw, /app\.js\?v=4\.19\.0/);
assert.match(sw, /assets\/voice/);
assert.match(swRegister, /sw\.js\?v=12/);
assert.match(app, /4\.19\.0/);

assert.equal(scriptLines.length, 90);
assert.equal(scriptLines[41], 'چهل و دو.');
assert.equal(manifest.provider, 'kenerate-sage-woman');
assert.equal(manifest.voice, 'Sage Woman');
assert.equal(manifest.language, 'fa-IR');
assert.equal(Number(manifest.version), 3);
assert.equal(Number(manifest.requiredNumbers), 90);
assert.equal(manifest.numbers['42']?.file, '042.mp3');
assert.equal(manifest.numbers['42']?.text, 'چهل و دو');
assert.ok(sampleStat.size >= 500);
assert.match(validator, /INCOMPLETE RELEASE/);
assert.match(validator, /MP3 clips/);
assert.match(importer, /--source/);
assert.match(importer, /configured: missing\.length === 0/);

console.log('Sage Woman audio smoke tests passed: the 42 reference clip is present, the 90-line script matches it, both web and Android use the same MP3 manager, and partial packs cannot enable room announcements.');
