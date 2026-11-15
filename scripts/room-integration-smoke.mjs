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
    throw new Error(method + ' ' + path + ' returned ' + response.status + ': ' + (data.error || 'no API error message') + (data.requestId ? ' [request ' + data.requestId + ']' : '') + (data.debug ? '\\n' + JSON.stringify(data.debug, null, 2) : ''));
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

// Voice audio is served as static Pages assets. The browser must validate
// the real 90-number manifest and MP3 before enabling the selected voice.
const voiceHealth = await request('/api/voice/health');
assert.equal(voiceHealth.ok, true);
assert.equal(voiceHealth.status, 'client-validation-required');
assert.equal(voiceHealth.ready, null);
assert.equal(voiceHealth.verifiedBy, 'client-audio-manager');
assert.equal(voiceHealth.provider, 'kenerate-sage-woman');
assert.equal(voiceHealth.voice, 'Sage Woman');
assert.equal(voiceHealth.language, 'fa-IR');
assert.equal(voiceHealth.requiredNumbers, 90);
assert.equal(voiceHealth.asset, '/assets/voice/sage-woman.mp3');
assert.equal(voiceHealth.manifest, '/assets/voice/sage-woman.json');

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
  assert.equal(snapshot.minPlayersToStart, 2);
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
  assert.equal(startedRoom.minPlayersToStart, 2);
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

// Public callers and browser clients must not be able to trigger server-owned draws.
const publicSchedulerAttempt = await fetch(baseUrl + '/api/tournaments/advance', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: '{}',
});
assert.equal(publicSchedulerAttempt.status, 401,
  'tournament advancement must reject requests without a verified GitHub Actions OIDC token');

// Tournament balances are atomic, registrations are unique, and the VIP window
// follows its real monthly schedule instead of being incorrectly assumed open every day.
const beforeTournament = await accountMe(accounts[0]);
const simpleEntry = await request('/api/tournaments/register', {
  account: accounts[0], method: 'POST', body: { type: 'simple' },
});
assert.equal(simpleEntry.tournament, 'simple');
const lobbyBeforeVip = await request('/api/tournaments');
const vipQueue = (lobbyBeforeVip.rooms || []).find(room => room.tournament_type === 'bingo');
assert.ok(vipQueue, 'monthly VIP queue must always be announced');
const vipRegistrationOpen = vipQueue.status === 'registration' && !vipQueue.registration_full;
let bingoEntry = null;
if (vipRegistrationOpen) {
  bingoEntry = await request('/api/tournaments/register', {
    account: accounts[0], method: 'POST', body: { type: 'bingo' },
  });
  assert.equal(bingoEntry.tournament, 'bingo');
} else {
  const closedVip = await fetch(baseUrl + '/api/tournaments/register', {
    method: 'POST',
    headers: { cookie: accounts[0].cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'bingo' }),
  });
  assert.equal(closedVip.status, 409, 'VIP registration must remain closed outside its seven-day window');
}
const tournamentBalance = await accountMe(accounts[0]);
assert.equal(Number(tournamentBalance.bingoCoins), Number(beforeTournament.bingoCoins) - 20 - (vipRegistrationOpen ? 100 : 0));
const tournamentState = await request('/api/tournaments/me', { account: accounts[0] });
assert.equal(tournamentState.entries.length, vipRegistrationOpen ? 2 : 1);
assert.equal(tournamentState.rooms.find(room => room.tournament_type === 'simple').registered_count, 1);
assert.equal(tournamentState.rooms.find(room => room.tournament_type === 'bingo').registered_count, vipRegistrationOpen ? 1 : 0);
const duplicateTournament = await fetch(baseUrl + '/api/tournaments/register', {
  method: 'POST',
  headers: { cookie: accounts[0].cookie, origin, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'simple' }),
});
assert.equal(duplicateTournament.status, 409, 'duplicate tournament entry must be rejected');
assert.equal(Number((await accountMe(accounts[0])).bingoCoins), Number(tournamentBalance.bingoCoins),
  'duplicate tournament entry must not deduct BGC');

// A scheduled simple cup with five entries must start its server-owned Bingo round,
// assign a private 3x9 card to each entry, and keep card data out of the public lobby.
for (const account of accounts.slice(1, 5)) {
  const extraEntry = await request('/api/tournaments/register', {
    account, method: 'POST', body: { type: 'simple' },
  });
  assert.equal(extraEntry.tournament, 'simple');
}
execFileSync('wrangler', [
  'd1', 'execute', 'dabernaz-ci', '--local',
  '--persist-to', '.wrangler/test-state',
  '--command', "UPDATE tournament_events SET scheduled_at = datetime('now', '-1 second') WHERE id = (SELECT id FROM tournament_events WHERE tournament_type='simple' AND status='registration' ORDER BY scheduled_at LIMIT 1)",
], { stdio: 'inherit' });

const publicLiveLobby = await request('/api/tournaments');
const publicLiveSimple = publicLiveLobby.rooms.find(room => room.tournament_type === 'simple');
assert.ok(publicLiveSimple, 'public lobby must preserve the simple tournament event');
assert.equal(publicLiveSimple.status, 'running', 'five registered players must start the tournament');
assert.equal(Object.hasOwn(publicLiveSimple, 'current_round'), false,
  'public tournament data must not expose private player cards or active draw state');
assert.equal(Object.hasOwn(publicLiveSimple, 'top_players'), false,
  'public tournament data must not expose player identities or scores');

const privateTournament = await request('/api/tournaments/me', { account: accounts[0] });
const privateSimple = privateTournament.rooms.find(room => room.tournament_type === 'simple');
assert.ok(privateSimple && privateSimple.current_round, 'registered players must receive the active round snapshot');
assert.equal(privateSimple.my_card.length, 3, 'each player must receive a private 3-row card');
assert.ok(privateSimple.my_card.every(row => row.length === 9), 'private card must have 9 columns');
const privateNumbers = privateSimple.my_card.flat().filter(Number.isInteger);
assert.equal(privateNumbers.length, 15, 'private card must contain exactly 15 numbers');
assert.equal(new Set(privateNumbers).size, 15, 'private card numbers must be unique');
const firstRoundCalled = privateSimple.current_round.called_numbers || [];
assert.ok(firstRoundCalled.length <= 1, 'a new tournament round must advance by at most one number per authenticated poll');
assert.equal(privateSimple.my_matched_count,
  privateNumbers.filter(number => firstRoundCalled.includes(number)).length,
  'private card match count must reflect the called numbers');

// Public lobby polling must never advance the live draw. When an authenticated player
// returns after a long delay, exactly one number is drawn, not the entire backlog.
execFileSync('wrangler', [
  'd1', 'execute', 'dabernaz-ci', '--local',
  '--persist-to', '.wrangler/test-state',
  '--command', "UPDATE tournament_rounds SET next_draw_at = 0 WHERE id = '" + privateSimple.current_round.id + "'",
], { stdio: 'inherit' });
const calledBeforeDelayedPoll = firstRoundCalled.length;
await request('/api/tournaments');
await request('/api/tournaments');
const dueAfterPublicPoll = await request('/api/tournaments/me', { account: accounts[0] });
const dueEventAfter = dueAfterPublicPoll.rooms.find(room => room.id === publicLiveSimple.id);
const calledAfter = (dueEventAfter.current_round.called_numbers || []).length;
assert.equal(calledAfter, calledBeforeDelayedPoll + 1,
  'an overdue authenticated draw must advance exactly one number, not catch up the whole backlog');
const immediateRepeat = await request('/api/tournaments/me', { account: accounts[0] });
const repeatedEvent = immediateRepeat.rooms.find(room => room.id === publicLiveSimple.id);
assert.equal((repeatedEvent.current_round.called_numbers || []).length, calledAfter,
  'a second poll before the three-second interval must not draw another number');


// Final settlement must pay the three published shares once, then remain idempotent.
const balancesBeforeSettlement = await Promise.all(accounts.slice(0, 5).map(async account =>
  Number((await accountMe(account)).bingoCoins)
));
const allBingoNumbers = JSON.stringify(Array.from({ length: 90 }, (_, index) => index + 1));
const finalFixtureSql = [
  "UPDATE tournament_events SET status='running',stage='final',stage_round=1,stage_rounds=1,stages_json='[{\"key\":\"final\",\"rounds\":1}]' WHERE id='" + publicLiveSimple.id + "'",
  "UPDATE tournament_rounds SET stage='final',round_number=1,status='finished',called_numbers_json='" + allBingoNumbers + "',line_winner_ids_json='[]',full_winner_ids_json='[]',next_draw_at=NULL,finished_at=datetime('now') WHERE id='" + privateSimple.current_round.id + "'"
].join('; ');
execFileSync('wrangler', [
  'd1', 'execute', 'dabernaz-ci', '--local',
  '--persist-to', '.wrangler/test-state',
  '--command', finalFixtureSql,
], { stdio: 'inherit' });

const settledTournament = await request('/api/tournaments/me', { account: accounts[0] });
const settledSimple = settledTournament.events.find(event => event.id === publicLiveSimple.id);
assert.equal(settledSimple.status, 'completed', 'final tournament round must settle and complete the event');
const expectedShares = [60, 25, 15, 0, 0];
const balancesAfterSettlement = await Promise.all(accounts.slice(0, 5).map(async account =>
  Number((await accountMe(account)).bingoCoins)
));
for (let index = 0; index < expectedShares.length; index++) {
  assert.equal(
    balancesAfterSettlement[index] - balancesBeforeSettlement[index],
    expectedShares[index],
    'simple tournament must pay the 60/25/15 prize split once to the top three ranked players'
  );
}
const finalStandings = await Promise.all(accounts.slice(0, 5).map(async account => {
  const personal = await request('/api/tournaments/me', { account });
  return personal.entries.find(entry => entry.event_id === publicLiveSimple.id)?.status || null;
}));
assert.deepEqual(
  finalStandings,
  ['winner_1','winner_2','winner_3','registered','registered'],
  'each player account must store its own final tournament status and winner rank'
);

// Repeated refreshes or scheduler invocations must never pay the same final prize twice.
await request('/api/tournaments/me', { account: accounts[0] });
const balancesAfterRepeatedSettlement = await Promise.all(accounts.slice(0, 5).map(async account =>
  Number((await accountMe(account)).bingoCoins)
));
assert.deepEqual(balancesAfterRepeatedSettlement, balancesAfterSettlement,
  'a completed tournament must not issue duplicate prize credits');

// A due event below the five-player minimum must cancel and refund its single entry.
const refundFixtureId = 'refund-' + runId;
const refundAccount = accounts[5];
const refundBalanceBefore = Number((await accountMe(refundAccount)).bingoCoins);
const refundFixtureSql = [
  "INSERT INTO tournament_events (id,tournament_type,scheduled_at,registration_opens_at,status,registered_count,capacity,prize_pool,min_players,stage,stages_json,stage_round,stage_rounds,created_at,updated_at) VALUES ('" +
    refundFixtureId + "','bingo',datetime('now','-1 second'),datetime('now','-2 days'),'registration',1,30,100,5,'registration','[]',1,1,datetime('now'),datetime('now'))",
  "UPDATE users SET bingo_coins=bingo_coins-100 WHERE id=" + Number(refundAccount.id) + " AND bingo_coins>=100",
  "INSERT INTO tournament_event_entries (event_id,user_id,entry_cost,status,created_at) VALUES ('" +
    refundFixtureId + "'," + Number(refundAccount.id) + ",100,'registered',datetime('now'))",
  "INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (" +
    Number(refundAccount.id) + ",'bingo_coin',-100,'QA refund fixture entry',datetime('now'))"
].join('; ');
execFileSync('wrangler', [
  'd1', 'execute', 'dabernaz-ci', '--local',
  '--persist-to', '.wrangler/test-state',
  '--command', refundFixtureSql,
], { stdio: 'inherit' });
await request('/api/tournaments');
const refundedTournament = await request('/api/tournaments/me', { account: refundAccount });
assert.equal(Number((await accountMe(refundAccount)).bingoCoins), refundBalanceBefore,
  'a tournament cancelled below five participants must refund the exact entry amount');
assert.equal(refundedTournament.entries.find(entry => entry.event_id === refundFixtureId)?.status, 'refunded',
  'cancelled tournament entries must be marked refunded');
assert.equal(refundedTournament.events.find(event => event.id === refundFixtureId)?.status, 'cancelled',
  'the underfilled tournament must be marked cancelled');

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
