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
  room5000: { price: 5000, linePrize: 20000, fullPrize: 115000, commissionMode: 'revenue_minus_prizes' },
  room10000: { price: 10000, linePrize: 40000, fullPrize: 230000, commissionMode: 'revenue_minus_prizes' },
  room20000: { price: 20000, linePrize: 80000, fullPrize: 460000, commissionMode: 'revenue_minus_prizes' },
  room50000: { price: 50000, linePrize: 200000, fullPrize: 1150000, commissionMode: 'revenue_minus_prizes' },
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

  // Four separate accounts first buy one card, then each purchases three additional cards.
  await Promise.all(accounts.slice(0, 4).map(account => join(account, roomId, 1)));
  for (let extra = 0; extra < 3; extra++) {
    await Promise.all(accounts.slice(0, 4).map(account => join(account, roomId, 1)));
  }
  let snapshot = await roomFor(accounts[0], roomId);
  assert.equal(snapshot.capacity, 30);
  assert.equal(snapshot.playerCount, 4, roomId + ': four registered players');
  assert.equal(snapshot.queueCount, 4, roomId + ': queue count is players, not cards');
  assert.equal(snapshot.cardCount, 16, roomId + ': additional card purchases must update shared count');
  assert.equal(snapshot.status, 'waiting');
  assert.deepEqual(snapshot.economics, economics);
  for (const account of accounts.slice(0, 4)) {
    const accountRoom = await roomFor(account, roomId);
    assert.equal(accountRoom.myCards.length, 4, roomId + ': each of the four initial players owns four cards');
  }
  const balanceBeforeFifthCard = Number((await accountMe(accounts[0])).balance);
  const fifthCardResponse = await fetch(baseUrl + '/api/rooms/' + roomId + '/join', {
    method: 'POST',
    headers: { cookie: accounts[0].cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ cardsCount: 1 }),
  });
  assert.equal(fifthCardResponse.status, 200, roomId + ': temporary per-player card cap must be removed');
  const fifthCardData = await fifthCardResponse.json();
  assert.equal(fifthCardData.room.cardCount, 17, roomId + ': fifth card must increment the shared room count');
  assert.equal(fifthCardData.room.myCards.length, 5, roomId + ': same player must own five cards during the temporary test');
  assert.equal(Number((await accountMe(accounts[0])).balance), balanceBeforeFifthCard - economics.price,
    roomId + ': fifth card must be charged exactly once');

  // Regression: logging out after a card purchase must not remove the paid
  // entry from the shared room. A second account must see the global counts,
  // and the first account must recover only its own cards after signing back in.
  await request('/api/auth/logout', { account: accounts[0], method: 'POST', body: {} });
  const afterLogoutFromOtherAccount = await roomFor(accounts[1], roomId);
  assert.equal(afterLogoutFromOtherAccount.playerCount, 4,
    roomId + ': logout must not remove a purchased player from the shared queue');
  assert.equal(afterLogoutFromOtherAccount.cardCount, 17,
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
  assert.equal(afterRelogin.cardCount, 17);

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
  assert.equal(snapshot.cardCount, 17);

  // Three further players buy four cards each: 29 cards in total.
  for (const account of accounts.slice(4, 7)) await join(account, roomId, 4);
  snapshot = await roomFor(accounts[0], roomId);
  assert.equal(snapshot.playerCount, 7);
  assert.equal(snapshot.cardCount, 29);
  assert.equal(snapshot.status, 'waiting');

  // Player eight requests four cards, but only one fits. Exactly one card and
  // exactly one card fee are accepted; the room starts at precisely 30 cards.
  const lastPlayerRoom = await join(accounts[7], roomId, 4);
  assert.equal(lastPlayerRoom.status, 'playing');
  assert.equal(lastPlayerRoom.capacity, 30);
  assert.equal(lastPlayerRoom.playerCount, 8);
  assert.equal(lastPlayerRoom.queueCount, 8);
  assert.equal(lastPlayerRoom.cardCount, 30);
  assert.equal(lastPlayerRoom.players.length, 8);
  assert.equal(lastPlayerRoom.myCards.length, 1);
  assert.equal(lastPlayerRoom.finance.totalPlayers, 8);
  assert.equal(lastPlayerRoom.finance.totalCards, 30);
  assert.equal(lastPlayerRoom.finance.grossRevenue, 30 * economics.price);

  for (let index = 0; index < accounts.length; index++) {
    const expectedCards = index === 0 ? 5 : index === 7 ? 1 : 4;
    const accountRoom = await roomFor(accounts[index], roomId);
    assert.equal(accountRoom.status, 'playing');
    assert.equal(accountRoom.playerCount, 8);
    assert.equal(accountRoom.cardCount, 30);
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
  assert.equal(finishedRoom.finance.totalCards, 30);
  assert.equal(finishedRoom.finance.grossRevenue, 30 * economics.price);
  assert.equal(finishedRoom.finance.linePrizePaid, economics.linePrize);
  assert.equal(finishedRoom.finance.fullPrizePaid, economics.fullPrize);
  const expectedCommission = 30 * economics.price - economics.linePrize - economics.fullPrize;
  assert.ok(expectedCommission >= 0);
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
  addSplitPrize(finishedRoom.winners.line, economics.linePrize);
  addSplitPrize(finishedRoom.winners.full, economics.fullPrize);

  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const cardCount = index === 0 ? 5 : index === 7 ? 1 : 4;
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

console.log('PASS: Daberna capacity, wallet debits, simultaneous winners, prize splits and winner history; referrals and milestone rewards; support ticket create/read; tournament queue registration and duplicate protection; server-authoritative RPS and tic-tac-toe with forged-result rejection.');
