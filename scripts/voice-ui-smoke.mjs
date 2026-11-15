import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, index, sw, swRegister, android, manifest, voiceScript, validator] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../sw-register.js', import.meta.url), 'utf8'),
  readFile(new URL('../android/app/src/main/java/app/dabernaz/club/MainActivity.java', import.meta.url), 'utf8'),
  readFile(new URL('../assets/voice/sage-woman.json', import.meta.url), 'utf8'),
  readFile(new URL('../docs/kenerate-90-number-script.txt', import.meta.url), 'utf8'),
  readFile(new URL('./voice-pack-validation.mjs', import.meta.url), 'utf8')
]);

assert.match(app, /const PersianAudioManager = \{/);
assert.match(app, /playEffectTone\(\)/);
assert.match(app, /supportsPlayback\(\)/);
assert.match(app, /speak\(number, options = \{\}\)/);
assert.match(app, /DabernazNativeTTS/);
assert.match(app, /voiceAudioVersion:\s*6/);
assert.match(app, /sage-woman\.json\?v=6/);
assert.match(app, /sage-woman\.mp3\?v=6/);
assert.match(app, /synth\.speak\(utterance\)/);

const testActionStart = app.indexOf("else if (action === 'test-number-voice')");
const roomActionStart = app.indexOf("else if (action === 'enable-room-audio')", testActionStart);
const testAction = app.slice(testActionStart, roomActionStart);
assert.match(testAction, /PersianAudioManager\.speak\(42,\s*\{\s*fromGesture:\s*true\s*\}\)/,
  'settings voice test must use the shared Audio Manager');

const roomSpeakStart = app.indexOf('function speakRoomNumber(number, room)');
const roomSpeakEnd = app.indexOf('\nconst ROOM_CONFIGS', roomSpeakStart);
const roomSpeak = app.slice(roomSpeakStart, roomSpeakEnd);
assert.match(roomSpeak, /PersianAudioManager\.speak\(value\)/,
  'room numbers must use the same Audio Manager');
assert.doesNotMatch(roomSpeak, /settingEnabled\('sounds'\)/,
  'number announcements must not be silently disabled by the separate sound-effects switch');
assert.match(roomSpeak, /spokenRoomAnnouncementKeys\.add\(announcementKey\)/,
  'a number is marked announced only after successful playback');
assert.match(roomSpeak, /roomSpeechRetryAt\.set\(announcementKey,\s*Date\.now\(\)\s*\+\s*7000\)/,
  'failed room announcements must be retried after a cooldown');

assert.match(android, /addJavascriptInterface\(new NativeTtsBridge\(\),\s*"DabernazNativeTTS"\)/);
assert.match(android, /TextToSpeech\.QUEUE_ADD/);
assert.match(android, /nativeTtsReady = true/);
assert.match(android, /setOnUtteranceProgressListener/);

assert.match(index, /styles\.css\?v=4\.6\.0/);
assert.match(index, /app\.js\?v=4\.21\.0/);
assert.match(sw, /dabernaz-shell-v23/);
assert.match(sw, /styles\.css\?v=4\.6\.0/);
assert.match(sw, /app\.js\?v=4\.21\.0/);
assert.match(swRegister, /sw\.js\?v=14/);
assert.match(app, /4\.21\.0/);
assert.match(android, /versionCode 4/);
assert.match(android, /versionName '4\.21\.0'/);

assert.match(voiceScript, /چهل دو/);
assert.doesNotMatch(voiceScript, /چهل و دو/);
assert.match(app, /numberToPersianSpeechText\(number\)/);
assert.match(app, /tour-my-card-grid/);
assert.match(app, /room\.my_card/);
assert.match(app, /tour-my-card-stats/);
assert.match(validator, /process\.exitCode = 1/);

const currentManifest = JSON.parse(manifest);
assert.equal(currentManifest.provider, 'kenerate-sage-woman');
assert.equal(currentManifest.voice, 'Sage Woman');
assert.equal(currentManifest.language, 'fa-IR');
assert.equal(currentManifest.trimming, 'none');
assert.equal(Number(currentManifest.gapSeconds), 0.18);
assert.equal(Number(currentManifest.sampleRate), 22050);
assert.equal(Number(currentManifest.channels), 1);
assert.equal(Object.keys(currentManifest.numbers).length, 90);
assert.ok(Object.values(currentManifest.numbers).every(clip => clip.trimStartSeconds === 0 && clip.trimEndSeconds === 0));
assert.equal(Number(currentManifest.requiredNumbers), 90);
assert.equal(typeof currentManifest.configured, 'boolean');
assert.ok(currentManifest.numbers && typeof currentManifest.numbers === 'object');
console.log('Persian Audio Manager smoke tests passed. Sage Woman release readiness is separately and strictly validated.');
