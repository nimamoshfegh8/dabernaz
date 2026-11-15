import assert from 'node:assert/strict';
import {
  TOURNAMENT_SCHEDULE,
  nextTournamentStartAt,
  buildTournamentStages,
  makeTournamentCard,
  scoreTournamentPlayers,
} from '../functions/tournament-rules.mjs';

const afterSimple = nextTournamentStartAt('simple', Date.UTC(2026,10,15,0,0,0));
assert.ok(afterSimple > Date.UTC(2026,10,15,0,0,0));
const afterVip = nextTournamentStartAt('bingo', Date.UTC(2026,10,15,0,0,0));
assert.ok(afterVip > Date.UTC(2026,10,15,0,0,0));
assert.equal(TOURNAMENT_SCHEDULE.simple.entryCost,20);
assert.equal(TOURNAMENT_SCHEDULE.bingo.entryCost,100);
assert.throws(()=>buildTournamentStages('simple',4),/حداقل/);
assert.ok(buildTournamentStages('simple',5).length >= 1);
assert.ok(buildTournamentStages('bingo',32).length >= 1);

let seed=1;
const randomInt=(max)=>{ seed=(seed*1103515245+12345)>>>0; return seed%max; };
const card=makeTournamentCard(randomInt);
assert.equal(card.length,3);
assert.equal(card.flat().filter(Number.isInteger).length,15);
assert.equal(new Set(card.flat().filter(Number.isInteger)).size,15);

const numbers=card.flat().filter(Number.isInteger);
const scored=scoreTournamentPlayers([{user_id:1,card_json:JSON.stringify(card)}],numbers);
assert.equal(scored[0].fullHit,true);
assert.ok(scored[0].score >= 1);

console.log('Tournament schedule and scoring smoke tests passed.');
