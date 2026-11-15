import assert from 'node:assert/strict';
import {
  TOURNAMENT_SCHEDULE,
  TOURNAMENT_TIME_ZONE,
  nextTournamentStartAt,
  buildTournamentStages,
  makeTournamentCard,
  scoreTournamentPlayers,
} from '../functions/tournament-rules.mjs';

function localDateParts(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TOURNAMENT_TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

const now = Date.UTC(2026, 10, 15, 0, 0, 0);
const simpleStart = nextTournamentStartAt('simple', now);
const vipStart = nextTournamentStartAt('bingo', now);
assert.ok(simpleStart > now);
assert.ok(vipStart > now);
assert.equal(TOURNAMENT_SCHEDULE.simple.entryCost, 20);
assert.equal(TOURNAMENT_SCHEDULE.bingo.entryCost, 100);
assert.equal(TOURNAMENT_SCHEDULE.simple.weekday, 4);
assert.equal(TOURNAMENT_SCHEDULE.bingo.weekday, 4);

const simpleLocal = localDateParts(simpleStart);
assert.equal(simpleLocal.weekday, 'Thursday');
assert.equal(simpleLocal.hour, '21');
assert.equal(simpleLocal.minute, '00');
const vipLocal = localDateParts(vipStart);
assert.equal(vipLocal.weekday, 'Thursday');
assert.equal(vipLocal.hour, '22');
assert.equal(vipLocal.minute, '00');
const vipYear = Number(vipLocal.year);
const vipMonth = Number(vipLocal.month);
const vipDay = Number(vipLocal.day);
const daysInVipMonth = new Date(Date.UTC(vipYear, vipMonth, 0)).getUTCDate();
for (let day = vipDay + 1; day <= daysInVipMonth; day++) {
  assert.notEqual(new Date(Date.UTC(vipYear, vipMonth - 1, day)).getUTCDay(), 4,
    'VIP must be held on the last Thursday of the month');
}

assert.throws(() => buildTournamentStages('simple', 4), /حداقل/);
assert.deepEqual(buildTournamentStages('simple', 8), [{ key: 'final', rounds: 3 }]);
assert.deepEqual(buildTournamentStages('simple', 12), [
  { key: 'qualifying', rounds: 2, advance: 8 },
  { key: 'final', rounds: 3 },
]);
assert.equal(buildTournamentStages('simple', 24)[1].key, 'semifinal');
assert.deepEqual(buildTournamentStages('bingo', 8), [{ key: 'final', rounds: 5 }]);
assert.equal(buildTournamentStages('bingo', 24)[1].key, 'semifinal');
assert.equal(buildTournamentStages('bingo', 40)[1].key, 'quarterfinal');

let seed = 1;
const randomInt = (max) => {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('Invalid random bound');
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed % max;
};

let lastCard;
for (let attempt = 0; attempt < 1000; attempt++) {
  const card = makeTournamentCard(randomInt);
  assert.equal(card.length, 3);
  assert.ok(card.every(row => row.filter(Number.isInteger).length === 5), 'each row must contain exactly five numbers');
  const numbers = card.flat().filter(Number.isInteger);
  assert.equal(numbers.length, 15);
  assert.equal(new Set(numbers).size, 15, 'a card must not contain duplicate numbers');
  for (let column = 0; column < 9; column++) {
    const values = card.map(row => row[column]).filter(Number.isInteger);
    assert.ok(values.length >= 1, 'each column must contain a number');
    assert.deepEqual(values, [...values].sort((a, b) => a - b), 'numbers in a column must be sorted');
    const minimum = column === 0 ? 1 : column * 10;
    const maximum = column === 8 ? 90 : column * 10 + 9;
    assert.ok(values.every(value => value >= minimum && value <= maximum), 'column numbers must use their 90-ball range');
  }
  lastCard = card;
}

const called = lastCard.flat().filter(Number.isInteger);
const player = { user_id: 1, card_json: JSON.stringify(lastCard) };
const simpleScore = scoreTournamentPlayers([player], called, 'simple')[0];
const vipScore = scoreTournamentPlayers([player], called, 'bingo')[0];
assert.equal(simpleScore.fullHit, true);
assert.equal(simpleScore.lineHit, true);
assert.equal(simpleScore.score, 44, 'simple tournament must use 10/25 plus 8 progress and 1 attendance point');
assert.equal(vipScore.fullHit, true);
assert.equal(vipScore.lineHit, true);
assert.equal(vipScore.score, 57, 'VIP tournament must use 15/30 plus 10 progress and 2 attendance points');

console.log('Tournament schedule, card generation and separate simple/VIP scoring tests passed.');
