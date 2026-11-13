import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const origin = new URL(baseUrl).origin;
const runId = randomUUID().slice(0, 8);
const password = 'Dabernaz-QA-2026!';
const accounts = [];
const startingBalance = 5000000;
const roomEconomics = {
  room5000: { price: 5000, linePrizePercent: 10, fullPrizePercent: 75, commissionPercent: 15 },
  room10000: { price: 10000, linePrizePercent: 10, fullPrizePercent: 75, commissionPercent: 15 },
  room20000: { price: 20000, linePrizePercent: 10, fullPrizePercent: 75, commissionPercent: 15 },
  room50000: { price: 50000, linePrizePercent: 10, fullPrizePercent: 75, commissionPercent: 15 },
};

async function request(path, options = {}) {
  const account = options.account;
  const method = options.method || 'GET';
  const headers = { accept: 'application/json' };
  if (account && account.cookie) headers.cookie = account.cookie;
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers.origin = origin;
  }
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(method + ' ' + path + ' returned ' + response.status + ': ' + (data.error || 'no API error message'));
  }
  return data;
}

function checkCard(cards, label, expectedCount) {
  assert.ok(Array.isArray(cards), label + ': no cards array returned');
  assert.equal(cards.length, expectedCount, label + ': wrong number of cards');
  for (const [cardIndex, card] of cards.entries()) {
    assert.equal(card.length, 3, label + ': card must have 3 rows');
    const numbers = card.flat().filter(Number.isInteger);
    assert.equal(numbers.length, 15, label + ': card must contain 15 numbers');
    assert.equal(new Set(numbers).size, 15, label + ': duplicate numbers in card');
    assert.ok(numbers.every(number => number >= 1 && number <= 90), label + ': number outside 1..90');
    for (const row of card) assert.equal(row.filter(Number.isInteger).length, 5);
    for (let column = 0; column < 9; column++) {
      const values = card.map(row => row[column]).filter(Number.isInteger);
      assert.ok(values.length >= 1, label + ': empty card column');
      assert.ok(values.every(number => number >= (column === 0 ? 1 : column * 10) &&
        number <= (column === 8 ? 90 : column * 10 + 9)), label + ': wrong bingo column');
    }
  }
}

async function accountMe(account) {
  const result = await request('/api/auth/me', { account });
  assert.equal(String(result.user && result.user.id), String(account.id));
  return result.user;
}
async function roomFor(account, roomId) {
  const result = await request('/api/rooms/' + roomId, { account });
  assert.equal(result.ok, true);
  return result.room;
}
async function join(account, roomId, cardsCount = 1) {
  const result = await request('/api/rooms/' + roomId + '/join', {
    account, method: 'POST', body: { cardsCount },
  });
  assert.equal(result.ok, true);
  return result.room;
}

const health = await request('/api/health');
assert.equal(health.ok, true);
assert.equal(health.database, 'D1');

// Persian number announcements are served from bundled, same-origin static assets.
// No Azure credentials or external TTS provider are required.
const voiceHealth = await request('/api/voice/health');
assert.equal(voiceHealth.ok, true);
assert.equal(voiceHealth.configured, true);
assert.equal(voiceHealth.provider, 'bundled-persian-audio');
assert.equal(voiceHealth.numbers, 90);
const voiceManifestResponse = await fetch(baseUrl + '/assets/voice/fa-numbers.json');
assert.equal(voiceManifestResponse.status, 200, 'bundled Persian voice manifest must be published');
const voiceManifest = await voiceManifestResponse.json();
assert.equal(voiceManifest.provider, 'bundled-persian-audio');
assert.equal(Object.keys(voiceManifest.numbers || {}).length, 90, 'voice manifest must contain all numbers 1..90');
for (let number = 1; number <= 90; number++) {
  const clip = voiceManifest.numbers[String(number)];
  assert.ok(clip && Number(clip.start) >= 0 && Number(clip.duration) > 0,
    'missing or invalid audio timing for number ' + number);
}
const voiceAudioResponse = await fetch(baseUrl + '/assets/voice/fa-numbers.mp3');
assert.equal(voiceAudioResponse.status, 200, 'bundled Persian MP3 must be published');
assert.match(voiceAudioResponse.headers.get('content-type') || '', /audio\/mpeg/i);
const voiceAudioBytes = await voiceAudioResponse.arrayBuffer();
assert.ok(voiceAudioBytes.byteLength > 200000, 'bundled Persian MP3 must not be empty');

const publicTournamentLobby = await request('/api/tournaments');
assert.equal(publicTournamentLobby.ok, true);
assert.deepEqual(
  (publicTournamentLobby.rooms || []).map(room => room.tournament_type).sort(),
  ['bingo', 'simple'],
  'public tournament lobby must expose both tournament queues'
);
assert.ok(
  publicTournamentLobby.rooms.every(room => Number.isFinite(Number(room.registered_count)) && Number(room.capacity) > 0),
  'public tournament lobby must expose aggregate registration counts only'
);

for (let index = 0; index < 8; index++) {
  const email = 'qa-' + runId + '-' + (index + 1) + '@example.test';
  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'QA Player ' + (index + 1), email, password },
  });
  assert.equal(registered.ok, true);
  assert.ok(registered.user && registered.user.id);
  accounts.push({ email, id: registered.user.id, memberId: registered.user.memberId });
}

const emailPrefix = 'qa-' + runId + '-%@example.test';
execFileSync('wrangler', [
  'd1', 'execute', 'dabernaz-ci', '--local',
  '--persist-to', '.wrangler/test-state',
  '--command', "UPDATE users SET balance = " + startingBalance + ", bingo_coins = 500 WHERE email LIKE '" + emailPrefix + "'",
], { stdio: 'inherit' });

for (const account of accounts) {
  const response = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, accept: 'application/json' },
    body: JSON.stringify({ email: account.email, password }),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, 'login failed for ' + account.email + ': ' + (data.error || ''));
  account.cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(account.cookie, /^dabernaz_session=[0-9a-f]{64}$/i);
  assert.equal(Number((await accountMe(account)).balance), startingBalance);
}

for (const roomId of ['room5000', 'room10000', 'room20000', 'room50000']) {
  const economics = roomEconomics[roomId];
  const balancesBeforeBuy = new Map();
  for (const account of accounts) balancesBeforeBuy.set(account.memberId, Number((await accountMe(account)).balance));

  // The first successful card purchase opens a fixed 150-second registration window.
  const firstPurchase = await join(accounts[0], roomId, 1);
  const firstDeadline = Number(firstPurchase.registrationDeadline);
  assert.equal(firstDeadline - Number(firstPurchase.registrationStartedAt), 150000);
  assert.equal(firstPurchase.registrationWindowMs, 150000);
  assert.equal(firstPurchase.maxCardsPerPlayer, 5);
  assert.ok(firstPurchase.registrationRemainingMs > 0 && firstPurchase.registrationRemainingMs <= 150000);
  await Promise.all(accounts.slice(1, 4).map(account => join(account, roomId, 1)));
  for (let extra = 0; extra < 4; extra++) {
    await Promise.all(accounts.slice(0, 4).map(account => join(account, roomId, 1)));
  }
  let snapshot = await roomFor(accounts[0], roomId);
  assert.equal(snapshot.capacity, null);
  assert.equal(snapshot.minPlayersToStart, 5);
  assert.equal(snapshot.playerCount, 4, roomId + ': four registered players');
  assert.equal(snapshot.queueCount, 4, roomId + ': queue count is players, not cards');
  assert.equal(snapshot.cardCount, 20, roomId + ': room accepts 20 sold cards before other players join');
  assert.equal(snapshot.status, 'waiting');
  assert.deepEqual(snapshot.economics, { price: economics.price });
  assert.equal(snapshot.registrationDeadline, firstDeadline, roomId + ': subsequent purchases do not extend the timer');
  for (const account of accounts.slice(0, 4)) {
    const accountRoom = await roomFor(account, roomId);
    assert.equal(accountRoom.myCards.length, 5, roomId + ': each of the four initial players owns five cards');
  }
  const balanceBeforeSixthCard = Number((await accountMe(accounts[0])).balance);
  const sixthCardResponse = await fetch(baseUrl + '/api/rooms/' + roomId + '/join', {
    method: 'POST',
    headers: { cookie: accounts[0].cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ cardsCount: 1 }),
  });
  assert.equal(sixthCardResponse.status, 409, roomId + ': sixth card must be rejected');
  assert.equal(Number((await accountMe(accounts[0])).balance), balanceBeforeSixthCard,
    roomId + ': rejected sixth card must not debit the wallet');
  assert.equal((await roomFor(accounts[0], roomId)).myCards.length, 5);

  // Regression: logging out after a card purchase must not remove the paid
  // entry from the shared room. A second account must see the global counts,
  // and the first account must recover only its own cards after signing back in.
  await request('/api/auth/logout', { account: accounts[0], method: 'POST', body: {} });
  const afterLogoutFromOtherAccount = await roomFor(accounts[1], roomId);
  assert.equal(afterLogoutFromOtherAccount.playerCount, 4,
    roomId + ': logout must not remove a purchased player from the shared queue');
  assert.equal(afterLogoutFromOtherAccount.cardCount, 20,
    roomId + ': logout must not remove purchased cards from the shared queue');
  const reloginResponse = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, accept: 'application/json' },
    body: JSON.stringify({ email: accounts[0].email, password }),
  });
  const reloginData = await reloginResponse.json().catch(() => ({}));
  assert.equal(reloginResponse.status, 200,
    roomId + ': first player must be able to sign back in: ' + (reloginData.error || ''));
  accounts[0].cookie = (reloginResponse.headers.get('set-cookie') || '').split(';', 1)[0];
  const afterRelogin = await roomFor(accounts[0], roomId);
  assert.equal(afterRelogin.joined, true, roomId + ': paid entry must survive logout and login');
  assert.equal(afterRelogin.myCards.length, 5, roomId + ': own cards must be restored after login');
  assert.equal(afterRelogin.playerCount, 4);
  assert.equal(afterRelogin.cardCount, 20);

  // A purchased place cannot be cancelled or refunded.
  const beforeLeave = Number((await accountMe(accounts[0])).balance);
  const leaveResponse = await fetch(baseUrl + '/api/rooms/' + roomId + '/leave', {
    method: 'POST',
    headers: { cookie: accounts[0].cookie, origin, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(leaveResponse.status, 409, roomId + ': leave must be rejected');
  assert.equal(Number((await accountMe(accounts[0])).balance), beforeLeave,
    roomId + ': no refund on attempted cancellation');
  snapshot = await roomFor(accounts[0], roomId);
  assert.equal(snapshot.playerCount, 4);
  assert.equal(snapshot.cardCount, 20);

  // Seven accounts purchase five cards each; this exceeds the old room cap.
  for (const account of accounts.slice(4, 7)) await join(account, roomId, 5);
  snapshot = await roomFor(accounts[0], roomId);
  assert.equal(snapshot.playerCount, 7);
  assert.equal(snapshot.cardCount, 35);
  assert.equal(snapshot.status, 'waiting');
  assert.equal(snapshot.registrationDeadline, firstDeadline);

  // The eighth player adds five cards. The room remains open until the fixed timer expires.
  const lastPlayerRoom = await join(accounts[7], roomId, 5);
  assert.equal(lastPlayerRoom.status, 'waiting');
  assert.equal(lastPlayerRoom.capacity, null);
  assert.equal(lastPlayerRoom.playerCount, 8);
  assert.equal(lastPlayerRoom.queueCount, 8);
  assert.equal(lastPlayerRoom.cardCount, 40);
  assert.equal(lastPlayerRoom.myCards.length, 5);
  assert.equal(lastPlayerRoom.registrationDeadline, firstDeadline);

  const expireSql = "UPDATE room_states SET payload = json_set(payload, '$.registrationDeadline', 1) WHERE room_id = '" + roomId + "'";
  execFileSync('wrangler', [
    'd1', 'execute', 'dabernaz-ci', '--local',
    '--persist-to', '.wrangler/test-state',
    '--command', expireSql,
  ], { stdio: 'inherit' });
  const startedRoom = await roomFor(accounts[0], roomId);
  assert.equal(startedRoom.status, 'playing');
  assert.equal(startedRoom.capacity, null);
  assert.equal(startedRoom.minPlayersToStart, 5);
  assert.equal(startedRoom.playerCount, 8);
  assert.equal(startedRoom.queueCount, 8);
  assert.equal(startedRoom.cardCount, 40);
  assert.equal(startedRoom.players.length, 8);
  assert.equal(startedRoom.myCards.length, 5);
  assert.equal(startedRoom.finance.totalPlayers, 8);
  assert.equal(startedRoom.finance.totalCards, 40);
  assert.equal(startedRoom.finance.grossRevenue, 40 * economics.price);

  const latePurchase = await fetch(baseUrl + '/api/rooms/' + roomId + '/join', {
    method: 'POST',
    headers: { cookie: accounts[0].cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ cardsCount: 1 }),
  });
  assert.equal(latePurchase.status, 409, roomId + ': purchases after the timer must be rejected');


  for (let index = 0; index < accounts.length; index++) {
    const expectedCards = 5;
    const accountRoom = await roomFor(accounts[index], roomId);
    assert.equal(accountRoom.status, 'playing');
    assert.equal(accountRoom.playerCount, 8);
    assert.equal(accountRoom.cardCount, 40);
    assert.equal(accountRoom.joined, true);
    checkCard(accountRoom.myCards, accounts[index].email, expectedCards);
    const expectedBalance = balancesBeforeBuy.get(accounts[index].memberId) -
      economics.price * expectedCards;
    assert.equal(Number((await accountMe(accounts[index])).balance), expectedBalance,
      roomId + ': wallet must immediately reflect actual card fees');
  }

  await new Promise(resolve => setTimeout(resolve, 3300));
  const liveRoom = await roomFor(accounts[0], roomId);
  assert.ok(liveRoom.drawCount >= 1);
  assert.equal(new Set(liveRoom.allCalledNumbers).size, liveRoom.allCalledNumbers.length);

  // Finish a deterministic local-only round: call 1..89 first, then the server's
  // next draw is 90. All cards become complete together, so simultaneous winner
  // lists are used to verify the equal prize split and round commission.
  const called89 = '[' + Array.from({ length: 89 }, (_, index) => index + 1).join(',') + ']';
  const forceEndSql = "UPDATE room_states SET payload = json_set(payload, " +
    "'$.calledNumbers', json('" + called89 + "'), " +
    "'$.nextDrawAt', 1, '$.status', 'playing', " +
    "'$.winners.line', json('null'), '$.winners.full', json('null'), " +
    "'$.linePrizePaid', 0, '$.fullPrizePaid', 0, '$.commissionFinalized', false) " +
    "WHERE room_id = '" + roomId + "'";
  execFileSync('wrangler', [
    'd1', 'execute', 'dabernaz-ci', '--local',
    '--persist-to', '.wrangler/test-state',
    '--command', forceEndSql,
  ], { stdio: 'inherit' });

  const finishedRoom = await roomFor(accounts[0], roomId);
  assert.equal(finishedRoom.status, 'finished');
  assert.equal(finishedRoom.finance.finalized, true);
  assert.equal(finishedRoom.finance.totalPlayers, 8);
  assert.equal(finishedRoom.finance.totalCards, 40);
  const grossRevenue = 40 * economics.price;
  const expectedLinePrize = Math.floor(grossRevenue * 0.10);
  const expectedFullPrize = Math.floor(grossRevenue * 0.75);
  const expectedCommission = grossRevenue - expectedLinePrize - expectedFullPrize;
  assert.equal(finishedRoom.finance.grossRevenue, grossRevenue);
  assert.equal(finishedRoom.finance.linePrizePaid, expectedLinePrize);
  assert.equal(finishedRoom.finance.fullPrizePaid, expectedFullPrize);
  assert.equal(expectedCommission, Math.floor(grossRevenue * 0.15));
  assert.equal(finishedRoom.finance.siteCommission, expectedCommission);
  assert.ok(finishedRoom.winners.line);
  assert.ok(finishedRoom.winners.full);

  const expectedPrizes = new Map(accounts.map((account) => [String(account.id), 0]));
  const addSplitPrize = (winners, prize) => {
    assert.ok(Array.isArray(winners) && winners.length > 0, roomId + ': winner list must be non-empty');
    const base = Math.floor(prize / winners.length);
    const remainder = prize % winners.length;
    winners.forEach((winner, index) => {
      const key = String(winner.userId);
      expectedPrizes.set(key, (expectedPrizes.get(key) || 0) + base + (index < remainder ? 1 : 0));
    });
  };
  addSplitPrize(finishedRoom.winners.line, expectedLinePrize);
  addSplitPrize(finishedRoom.winners.full, expectedFullPrize);

  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const cardCount = 5;
    const expectedBalance = balancesBeforeBuy.get(account.memberId) -
      economics.price * cardCount + expectedPrizes.get(String(account.id));
    assert.equal(Number((await accountMe(account)).balance), expectedBalance,
      roomId + ': split winner prizes and card charges must match the wallet');
  }

  const ledgerOutput = execFileSync('wrangler', [
    'd1', 'execute', 'dabernaz-ci', '--local',
    '--persist-to', '.wrangler/test-state',
    '--command', "SELECT COUNT(*) AS rounds, SUM(site_commission) AS total_commission FROM room_finances WHERE room_id = '" + roomId + "'",
  ], { encoding: 'utf8' });
  assert.match(ledgerOutput, new RegExp(String(expectedCommission)));
  const repeatedRead = await roomFor(accounts[0], roomId);
  assert.equal(repeatedRead.finance.siteCommission, expectedCommission);
  const history = await request('/api/rooms/history');
  const storedRound = (history.rounds || []).find(round => round.room_id === roomId);
  assert.ok(storedRound, roomId + ': finished round must appear in public history');
  assert.ok(Array.isArray(storedRound.lineWinners) && storedRound.lineWinners.length > 0,
    roomId + ': line winners must be persisted in room_finances');
  assert.ok(Array.isArray(storedRound.fullWinners) && storedRound.fullWinners.length > 0,
    roomId + ': full winners must be persisted in room_finances');
}

// Referral reward: five distinct newly registered accounts grant exactly one milestone.
const inviterBefore = await accountMe(accounts[0]);
for (let index = 0; index < 5; index++) {
  const invited = await request('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'QA Referral ' + (index + 1),
      email: 'ref-' + runId + '-' + (index + 1) + '@example.test',
      password,
      referralCode: 'DABERNAZ' + accounts[0].memberId,
    },
  });
  assert.equal(invited.ok, true, 'referral registration must succeed');
}
const inviterAfter = await accountMe(accounts[0]);
assert.equal(Number(inviterAfter.balance), Number(inviterBefore.balance) + 20000,
  'five confirmed referrals must grant 20,000 toman wallet credit');
assert.equal(Number(inviterAfter.bingoCoins), Number(inviterBefore.bingoCoins) + 5,
  'five confirmed referrals must grant 5 BGC');
const referralSummary = await request('/api/referrals', { account: accounts[0] });
assert.equal(referralSummary.count, 5);
assert.equal(referralSummary.nextRewardIn, 5);

// Support ticket writes and authenticated reads must round-trip.
const ticketSubject = 'QA Support ' + runId;
const ticketCreated = await request('/api/support', {
  account: accounts[0], method: 'POST',
  body: { subject: ticketSubject, message: 'Automated end-to-end support ticket test.' },
});
assert.ok(ticketCreated.ticketId > 0);
const ticketList = await request('/api/tickets', { account: accounts[0] });
assert.ok(ticketList.tickets.some(ticket => ticket.id === ticketCreated.ticketId && ticket.subject === ticketSubject));

// Tournament balances are atomic, registrations are unique, and both entry types appear in the queue.
const beforeTournament = await accountMe(accounts[0]);
const simpleEntry = await request('/api/tournaments/register', {
  account: accounts[0], method: 'POST', body: { type: 'simple' },
});
assert.equal(simpleEntry.tournament, 'simple');
const bingoEntry = await request('/api/tournaments/register', {
  account: accounts[0], method: 'POST', body: { type: 'bingo' },
});
assert.equal(bingoEntry.tournament, 'bingo');
const tournamentBalance = await accountMe(accounts[0]);
assert.equal(Number(tournamentBalance.bingoCoins), Number(beforeTournament.bingoCoins) - 120);
const tournamentState = await request('/api/tournaments/me', { account: accounts[0] });
assert.equal(tournamentState.entries.length, 2);
assert.equal(tournamentState.rooms.find(room => room.tournament_type === 'simple').registered_count, 1);
assert.equal(tournamentState.rooms.find(room => room.tournament_type === 'bingo').registered_count, 1);
const duplicateTournament = await fetch(baseUrl + '/api/tournaments/register', {
  method: 'POST',
  headers: { cookie: accounts[0].cookie, origin, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'simple' }),
});
assert.equal(duplicateTournament.status, 409, 'duplicate tournament entry must be rejected');
assert.equal(Number((await accountMe(accounts[0])).bingoCoins), Number(tournamentBalance.bingoCoins),
  'duplicate tournament entry must not deduct BGC');

// Client-supplied outcomes are rejected; only server-computed game sessions count.
const statsBefore = await accountMe(accounts[0]);
const forgedResult = await fetch(baseUrl + '/api/games/result', {
  method: 'POST',
  headers: { cookie: accounts[0].cookie, origin, 'content-type': 'application/json' },
  body: JSON.stringify({ gameType: 'rps', result: 'win' }),
});
assert.equal(forgedResult.status, 405, 'self-reported game outcomes must not be accepted');
assert.equal(Number((await accountMe(accounts[0])).stats.gamesPlayed), Number(statsBefore.stats.gamesPlayed),
  'forged outcomes must not change the account stats');

// RPS server match owns the score and opponent choice; keep playing until a best-of-three result.
let rpsMatch = (await request('/api/games/start', {
  account: accounts[0], method: 'POST', body: { gameType: 'rps' },
})).match;
assert.ok(rpsMatch.id);
const activeRps = await request('/api/games/active?gameType=rps', { account: accounts[0] });
assert.equal(activeRps.match.id, rpsMatch.id, 'active RPS match must survive reload');
for (let attempt = 0; attempt < 40 && !rpsMatch.finished; attempt++) {
  const moved = await request('/api/games/move', {
    account: accounts[0], method: 'POST',
    body: { matchId: rpsMatch.id, choice: 'rock' },
  });
  assert.equal(moved.lastRound.player, 'rock');
  assert.ok(['rock','paper','scissors'].includes(moved.lastRound.bot));
  rpsMatch = moved.match;
}
assert.equal(rpsMatch.finished, true, 'server must finish best-of-three RPS');
assert.ok(['win','lose'].includes(rpsMatch.result));

// Tic-tac-toe server match validates legal moves and determines bot replies + final result.
let ticMatch = (await request('/api/games/start', {
  account: accounts[0], method: 'POST', body: { gameType: 'tic' },
})).match;
assert.ok(ticMatch.id);
const activeTic = await request('/api/games/active?gameType=tic', { account: accounts[0] });
assert.equal(activeTic.match.id, ticMatch.id);
for (let attempt = 0; attempt < 9 && !ticMatch.finished; attempt++) {
  const index = ticMatch.board.findIndex(value => !value);
  assert.ok(index >= 0);
  const moved = await request('/api/games/move', {
    account: accounts[0], method: 'POST', body: { matchId: ticMatch.id, index },
  });
  ticMatch = moved.match;
}
assert.equal(ticMatch.finished, true, 'tic-tac-toe must finish based on server moves');
assert.ok(['win','lose','draw'].includes(ticMatch.result));
const statsAfter = await accountMe(accounts[0]);
assert.equal(Number(statsAfter.stats.gamesPlayed), Number(statsBefore.stats.gamesPlayed) + 2);
assert.equal(Number(statsAfter.stats.wins), Number(statsBefore.stats.wins) + (rpsMatch.result === 'win' ? 1 : 0) + (ticMatch.result === 'win' ? 1 : 0));
assert.equal(Number(statsAfter.stats.points), Number(statsBefore.stats.points) + ((rpsMatch.result === 'win' ? 1 : 0) + (ticMatch.result === 'win' ? 1 : 0)) * 10);

for (const account of accounts) {
  await request('/api/auth/logout', { account, method: 'POST', body: {} });
}

console.log('PASS: Daberna uncapped rooms, minimum-five-player policy, 150-second first-purchase timer, per-account five-card limit, deadline/late-purchase enforcement, prize calculations, simultaneous winners and history; referrals; support tickets; tournaments; server-authoritative mini-games.');
