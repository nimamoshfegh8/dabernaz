import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');

assert.match(app, /rpsMatch\.awaitingNext\s*&&\s*lastRound/,
  'RPS must show the next-round button only while awaiting the player confirmation');
assert.match(app, /function nextRpsRound\(\)[\s\S]*?rpsMatch\.awaitingNext\s*=\s*false;[\s\S]*?renderRpsMatch\(rpsMatch\.last\)/,
  'RPS next-round action must transition back to enabled player choices');
assert.match(app, /async function playRps\(choice\)[\s\S]*?rpsMoveBusy/,
  'RPS must block duplicate clicks while a move is being submitted');
assert.match(app, /async function resetTicMatch\(\)[\s\S]*?\/api\/games\/abandon[\s\S]*?\/api\/games\/start/,
  'Tic reset must abandon the active match and create a new server session');
assert.match(app, /async function playTicMove\(index\)[\s\S]*?ticMoveBusy/,
  'Tic must block duplicate clicks while a move is being submitted');
assert.match(app, /else if \(action === 'tic-reset'\) resetTicMatch\(\)/,
  'Tic reset control must use its dedicated abandon-and-restart action');

const roomCopy = app.split('\n').filter(line => /اتاق|دبرنا/.test(line)).join('\n');
assert.match(roomCopy, /حداقل ۲ شرکت‌کننده/,
  'room lobby must disclose the actual two-player minimum');
assert.doesNotMatch(roomCopy, /حداقل ۵ شرکت‌کننده/,
  'room UI must not contradict the server with a five-player minimum');
assert.match(app, /room5000[\s\S]*?room10000[\s\S]*?room20000[\s\S]*?room50000/,
  'all four price-tier room IDs must remain available');
assert.match(app, /queue\.status === 'finished'[\s\S]*?data-action="room-next-session"/,
  'a finished room must offer a separate next-session action, not a purchase action');
const nextSessionHandler = app.match(/if \(action === 'room-next-session'\) \{([\s\S]*?)\n  \}\n  if \(action === 'room-join-auto'\)/)?.[1] || '';
assert.match(nextSessionHandler, /\/api\/rooms\/\$\{activeRoomId\}\/next/,
  'opening the next session must call the no-purchase endpoint');
assert.doesNotMatch(nextSessionHandler, /\/join|cardsCount|loadAuthenticatedUser/,
  'opening the next session must not trigger card purchase or wallet refresh');
const explicitPurchaseHandler = app.match(/if \(action === 'room-join-auto'\) \{([\s\S]*?)\n  \}\n  if \(action === 'room-add-card'\)/)?.[1] || '';
assert.match(explicitPurchaseHandler, /purchaseConfirmed\s*:\s*true/,
  'a new room card may be purchased only through the explicit purchase action');

console.log('Game-room and mini-game UI smoke tests passed.');
