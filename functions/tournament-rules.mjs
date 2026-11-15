export const TOURNAMENT_TIME_ZONE = 'Asia/Tehran';
export const TOURNAMENT_SCHEDULE = Object.freeze({
  simple: Object.freeze({ weekday: 4, hour: 21, minute: 0, registrationDays: 7, entryCost: 20, prizeShares: [60, 25, 15] }),
  bingo: Object.freeze({ weekday: 4, hour: 22, minute: 0, registrationDays: 7, entryCost: 100, prizeShares: [50, 30, 20] }),
});

function zonedParts(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TOURNAMENT_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const result = {};
  for (const item of parts) if (item.type !== 'literal') result[item.type] = Number(item.value);
  return result;
}

function zonedTimeToUtc(year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = zonedParts(guess);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const correction = target - represented;
    guess += correction;
    if (correction === 0) break;
  }
  return guess;
}

function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function lastWeekdayOfMonth(year, month, weekday) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const delta = (weekdayOf(year, month, lastDay) - weekday + 7) % 7;
  return lastDay - delta;
}

export function nextTournamentStartAt(type, nowMs = Date.now()) {
  const config = TOURNAMENT_SCHEDULE[type];
  if (!config) throw new TypeError('نوع تورنومنت معتبر نیست.');
  const local = zonedParts(nowMs);
  if (type === 'simple') {
    const todayWeekday = weekdayOf(local.year, local.month, local.day);
    let daysUntil = (config.weekday - todayWeekday + 7) % 7;
    const alreadyPassed = daysUntil === 0 &&
      (local.hour > config.hour || (local.hour === config.hour && local.minute >= config.minute));
    if (alreadyPassed) daysUntil = 7;
    const target = new Date(Date.UTC(local.year, local.month - 1, local.day + daysUntil));
    return zonedTimeToUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), config.hour, config.minute);
  }

  let year = local.year;
  let month = local.month;
  let day = lastWeekdayOfMonth(year, month, config.weekday);
  let candidate = zonedTimeToUtc(year, month, day, config.hour, config.minute);
  if (candidate <= nowMs) {
    const nextMonth = new Date(Date.UTC(year, month, 1));
    year = nextMonth.getUTCFullYear();
    month = nextMonth.getUTCMonth() + 1;
    day = lastWeekdayOfMonth(year, month, config.weekday);
    candidate = zonedTimeToUtc(year, month, day, config.hour, config.minute);
  }
  return candidate;
}

export function buildTournamentStages(type, playerCount) {
  if (!Number.isInteger(playerCount) || playerCount < 5) throw new RangeError('برای شروع حداقل ۵ شرکت‌کننده لازم است.');
  if (type === 'simple') {
    if (playerCount <= 8) return [{ key: 'final', rounds: 3 }];
    if (playerCount <= 16) return [{ key: 'qualifying', rounds: 2, advance: 8 }, { key: 'final', rounds: 3 }];
    return [{ key: 'qualifying', rounds: 2, advance: 16 }, { key: 'semifinal', rounds: 2, advance: 8 }, { key: 'final', rounds: 3 }];
  }
  if (type === 'bingo') {
    if (playerCount <= 8) return [{ key: 'final', rounds: 5 }];
    if (playerCount <= 16) return [{ key: 'qualifying', rounds: 2, advance: 8 }, { key: 'final', rounds: 5 }];
    if (playerCount <= 32) return [{ key: 'qualifying', rounds: 2, advance: 16 }, { key: 'semifinal', rounds: 3, advance: 8 }, { key: 'final', rounds: 5 }];
    return [
      { key: 'qualifying', rounds: 2, advance: 32 },
      { key: 'quarterfinal', rounds: 2, advance: 16 },
      { key: 'semifinal', rounds: 3, advance: 8 },
      { key: 'final', rounds: 5 },
    ];
  }
  throw new TypeError('نوع تورنومنت معتبر نیست.');
}

export function makeTournamentCard(randomInt) {
  if (typeof randomInt !== 'function') throw new TypeError('مولد عدد تصادفی معتبر نیست.');
  const grid = Array.from({ length: 3 }, () => Array(9).fill(null));
  for (let row = 0; row < 3; row++) {
    const columns = Array.from({ length: 9 }, (_, index) => index);
    for (let index = columns.length - 1; index > 0; index--) {
      const swap = randomInt(index + 1);
      [columns[index], columns[swap]] = [columns[swap], columns[index]];
    }
    for (const column of columns.slice(0, 5)) grid[row][column] = 0;
  }
  const columnCounts = Array(9).fill(0);
  for (let column = 0; column < 9; column++) {
    for (let row = 0; row < 3; row++) if (grid[row][column] === 0) columnCounts[column]++;
  }
  for (let missing = 0; missing < 9; missing++) {
    if (columnCounts[missing] > 0) continue;
    const moves = [];
    for (let row = 0; row < 3; row++) {
      if (grid[row][missing] !== null) continue;
      for (let donor = 0; donor < 9; donor++) {
        if (grid[row][donor] === 0 && columnCounts[donor] > 1) moves.push([row, donor]);
      }
    }
    if (!moves.length) throw new Error('ساخت کارت معتبر تورنومنت ممکن نشد.');
    const [row, donor] = moves[randomInt(moves.length)];
    grid[row][donor] = null;
    grid[row][missing] = 0;
    columnCounts[donor]--;
    columnCounts[missing]++;
  }
  for (let column = 0; column < 9; column++) {
    const min = column === 0 ? 1 : column * 10;
    const max = column === 8 ? 90 : column * 10 + 9;
    const rows = [];
    for (let row = 0; row < 3; row++) if (grid[row][column] === 0) rows.push(row);
    const values = Array.from({ length: max - min + 1 }, (_, index) => min + index);
    for (let index = values.length - 1; index > 0; index--) {
      const swap = randomInt(index + 1);
      [values[index], values[swap]] = [values[swap], values[index]];
    }
    const selected = values.slice(0, rows.length).sort((a, b) => a - b);
    rows.forEach((row, index) => { grid[row][column] = selected[index]; });
  }
  return grid;
}

function cardNumbers(card) {
  return card.flat().filter(Number.isInteger);
}

function lineComplete(card, called) {
  const calledSet = new Set(called);
  return card.some((row) => {
    const numbers = row.filter(Number.isInteger);
    return numbers.length === 5 && numbers.every((number) => calledSet.has(number));
  });
}

export function scoreTournamentPlayers(players, calledNumbers) {
  const called = new Set(calledNumbers);
  const evaluated = players.map((player) => {
    const card = typeof player.card_json === 'string' ? JSON.parse(player.card_json) : player.card_json;
    const numbers = cardNumbers(card);
    const matchedCount = numbers.filter((number) => called.has(number)).length;
    return {
      userId: Number(player.user_id),
      matchedCount,
      lineHit: lineComplete(card, calledNumbers),
      fullHit: numbers.length === 15 && matchedCount === 15,
      progressBonus: 0,
    };
  });
  const ranked = [...evaluated].sort((a, b) => b.matchedCount - a.matchedCount || a.userId - b.userId);
  const bonuses = [8, 6, 4];
  let cursor = 0;
  while (cursor < ranked.length && cursor < bonuses.length) {
    let end = cursor + 1;
    while (end < ranked.length && ranked[end].matchedCount === ranked[cursor].matchedCount) end++;
    const earned = bonuses.slice(cursor, Math.min(end, bonuses.length));
    const average = earned.length ? Math.round(earned.reduce((sum, value) => sum + value, 0) / (end - cursor)) : 0;
    for (let index = cursor; index < end; index++) ranked[index].progressBonus = average;
    cursor = end;
  }
  return evaluated.map((player) => ({
    ...player,
    score: 1 + (player.lineHit ? 10 : 0) + (player.fullHit ? 25 : 0) + player.progressBonus,
  }));
}

export function tournamentTieBreakLabel() {
  return 'امتیاز کل، تعداد برد کامل، تعداد برد خطی، تعداد دورهای انجام‌شده و سپس زمان ثبت‌نام.';
}
