import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const config = "workers/room-coordinator/wrangler.ci.toml";
const database = "dabernaz-local-ci";
const port = Number(process.env.ROOM_COORDINATOR_PORT || 8790);
const baseUrl = `http://127.0.0.1:${port}`;
const persist = await mkdtemp(path.join(tmpdir(), "dabernaz-room-do-"));
const tempSql = path.join(persist, "seed.sql");
let worker = null;
let workerLog = "";
let failed = false;

function wrangler(args, options = {}) {
  try {
    return execFileSync("npx", ["wrangler", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: options.timeout || 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout = String(error.stdout || "");
    const stderr = String(error.stderr || "");
    throw new Error(`wrangler ${args.join(" ")} failed\n${stdout}\n${stderr}`);
  }
}

function d1(args) {
  const output = wrangler([
    "d1", "execute", database,
    "--config", config,
    "--local",
    "--persist-to", persist,
    "--yes",
    "--json",
    ...args,
  ]);
  try {
    const parsed = JSON.parse(output.trim());
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    const rows = statements.flatMap((statement) => {
      if (Array.isArray(statement?.results)) return statement.results;
      if (Array.isArray(statement?.result?.results)) return statement.result.results;
      return [];
    });
    const failedStatement = statements.find((statement) => statement?.success === false);
    if (failedStatement) throw new Error(JSON.stringify(failedStatement));
    return rows;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`D1 JSON output could not be parsed: ${output}`);
    throw error;
  }
}

function query(sql) {
  return d1(["--command", sql]);
}

function one(sql) {
  const rows = query(sql);
  assert.ok(rows.length, `Expected one D1 result row for SQL: ${sql}`);
  return rows[0];
}

function startWorker() {
  workerLog = "";
  worker = spawn("npx", [
    "wrangler", "dev",
    "--config", config,
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--persist-to", persist,
  ], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
  });
  worker.stdout.on("data", (chunk) => { workerLog = (workerLog + chunk.toString()).slice(-20_000); });
  worker.stderr.on("data", (chunk) => { workerLog = (workerLog + chunk.toString()).slice(-20_000); });
  worker.once("exit", (code, signal) => {
    if (!failed && code !== 0 && signal !== "SIGTERM") {
      console.error("Local Worker exited unexpectedly:", code, signal, workerLog);
    }
  });
  return worker;
}

async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  const current = worker;
  try { process.kill(-current.pid, "SIGTERM"); }
  catch { current.kill("SIGTERM"); }
  await Promise.race([
    new Promise((resolve) => current.once("exit", resolve)),
    delay(5_000),
  ]);
  if (current.exitCode === null) {
    try { process.kill(-current.pid, "SIGKILL"); } catch { current.kill("SIGKILL"); }
    await delay(250);
  }
  worker = null;
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!worker || worker.exitCode !== null) {
      throw new Error(`Local Worker stopped before becoming ready.\n${workerLog}`);
    }
    try {
      const response = await fetch(baseUrl + "/rooms/room5000");
      if (response.ok) return;
      lastError = new Error(`Worker returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`Local Worker did not become ready: ${lastError}\n${workerLog}`);
}

async function assertWorkerHealth() {
  const response = await fetch(baseUrl + "/health");
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, "Worker health must confirm the D1 and Durable Object bindings: " + JSON.stringify(data));
  assert.equal(data.ready, true);
  assert.equal(data.schema, "v4");
  assert.equal(data.transactionRoundLink, true);
  assert.equal(data.durableObject?.ready, true);
}

async function requestRoom(roomId, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.userId) headers.set("x-dabernaz-user-id", String(options.userId));
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(baseUrl + `/rooms/${roomId}` + (options.action ? `/${options.action}` : ""), {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function waitForSnapshot(roomId, userId, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await requestRoom(roomId, { userId });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    last = response.data.room;
    if (predicate(last)) return last;
    await delay(180);
  }
  throw new Error(`Timed out waiting for ${roomId} snapshot. Last state: ${JSON.stringify(last)}`);
}

function assertValidCard(card) {
  assert.equal(card.length, 3, "Bingo card must have three rows");
  let count = 0;
  for (const row of card) {
    assert.equal(row.length, 9);
    const values = row.filter(Number.isInteger);
    assert.equal(values.length, 5, "Each card row must contain five numbers");
    count += values.length;
    assert.ok(values.every((value) => value >= 1 && value <= 90));
  }
  assert.equal(count, 15, "Each card must contain fifteen numbers");
  for (let col = 0; col < 9; col += 1) {
    const values = card.map((row) => row[col]).filter(Number.isInteger);
    assert.ok(values.length >= 1 && values.length <= 3);
    const min = col === 0 ? 1 : col * 10;
    const max = col === 8 ? 90 : col * 10 + 9;
    assert.ok(values.every((value) => value >= min && value <= max));
    assert.deepEqual(values, [...values].sort((a, b) => a - b));
  }
}

async function applyLocalMigrationsAndSeed() {
  wrangler(["d1", "execute", database, "--config", config, "--local", "--persist-to", persist,
    "--yes", "--file", "migrations/0000_core_schema.sql"]);
  for (const migration of [
    "migrations/0001_room_rounds_financial_queue.sql",
    "migrations/0002_wallet_request_idempotency.sql",
    "migrations/0003_tournament_entry_idempotency.sql",
    "migrations/0004_transaction_round_link.sql",
  ]) {
    wrangler(["d1", "execute", database, "--config", config, "--local", "--persist-to", persist,
      "--yes", "--file", migration]);
  }
  const seed = [
    ...Array.from({ length: 27 }, (_, index) => {
      const id = 910001 + index;
      const n = index + 1;
      return `INSERT INTO users(id,username,password_hash,balance,bingo_coins,created_at,email,member_id,games_played,wins,points) VALUES(${id},'ci-room-user-${n}','test-only-not-a-real-credential',1000000,500,'2026-11-17T00:00:00.000Z','room-user-${n}@example.invalid','CIROOM${n}',0,0,0);`;
    }),
  ].join("\n");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(tempSql, seed, "utf8");
  wrangler(["d1", "execute", database, "--config", config, "--local", "--persist-to", persist,
    "--yes", "--file", tempSql]);
  const users = one("SELECT COUNT(*) AS count FROM users WHERE id BETWEEN 910001 AND 910027");
  assert.equal(Number(users.count), 27, "Twenty-seven isolated synthetic test users must be seeded");
  const schema = one("SELECT MAX(version) AS version FROM schema_migrations");
  assert.equal(Number(schema.version), 4, "All four versioned D1 migrations must be applied locally");
}

async function main() {
  await mkdir(persist, { recursive: true });
  await applyLocalMigrationsAndSeed();

  startWorker();
  await waitForServer();
  await assertWorkerHealth();

  const invalidSixBefore = Number(one("SELECT balance FROM users WHERE id=910022").balance);
  const invalidSix = await requestRoom("room10000", {
    method: "POST", action: "join", userId: 910022, idempotencyKey: "six-cards-in-one-request-0001",
    body: { cardsCount: 6, purchaseConfirmed: true },
  });
  assert.equal(invalidSix.status, 400, "A request for more than five cards must be rejected, not silently clamped");
  assert.equal(Number(one("SELECT balance FROM users WHERE id=910022").balance), invalidSixBefore,
    "An invalid six-card request must not debit the user");

  // GET must not create an empty round, change status, refund, draw, or write state.
  const before = Number(one("SELECT COUNT(*) AS count FROM room_rounds").count);
  const empty = await requestRoom("room5000");
  assert.equal(empty.status, 200);
  assert.equal(empty.data.room.status, "waiting");
  const after = Number(one("SELECT COUNT(*) AS count FROM room_rounds").count);
  assert.equal(after, before, "GET must be strictly read-only");

  // Requests without server-derived identity must never debit a wallet.
  const noIdentity = await requestRoom("room5000", {
    method: "POST", action: "join", idempotencyKey: "no-identity-test-0001",
    body: { cardsCount: 1, purchaseConfirmed: true },
  });
  assert.equal(noIdentity.status, 401);

  // Exactly 20 distinct accounts may join one round. Account 21 must be
  // rejected without a debit or a purchase row.
  for (let index = 1; index <= 20; index += 1) {
    const response = await requestRoom("room50000", {
      method: "POST", action: "join", userId: 910000 + index,
      idempotencyKey: "capacity-user-" + String(index).padStart(2, "0") + "-room50000",
      body: { cardsCount: 1, purchaseConfirmed: true },
    });
    assert.equal(response.status, 200, "Capacity join " + index + " must succeed: " + JSON.stringify(response.data));
  }
  const capacityRound = one("SELECT id,status FROM room_rounds WHERE room_id='room50000' ORDER BY sequence DESC LIMIT 1");
  assert.equal(capacityRound.status, "registration_open");
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_round_players WHERE round_id='" + capacityRound.id + "'").count), 20);
  const twentyFirstBalance = Number(one("SELECT balance FROM users WHERE id=910021").balance);
  const twentyFirst = await requestRoom("room50000", {
    method: "POST", action: "join", userId: 910021,
    idempotencyKey: "capacity-user-21-room50000",
    body: { cardsCount: 1, purchaseConfirmed: true },
  });
  assert.equal(twentyFirst.status, 409, "Player 21 must be rejected when the room is full");
  assert.equal(Number(one("SELECT balance FROM users WHERE id=910021").balance), twentyFirstBalance,
    "A player rejected by capacity must not be charged");
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_round_players WHERE round_id='" + capacityRound.id + "'").count), 20);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_purchases WHERE round_id='" + capacityRound.id + "'").count), 20);

  // GET action URLs are invalid and must not initialize or mutate DO state.
  const invalidGetBefore = one("SELECT COUNT(*) AS count FROM room_rounds WHERE room_id='room20000'");
  const invalidJoinGet = await requestRoom("room20000", { method: "GET", action: "join", userId: 910001 });
  const invalidReconcileGet = await requestRoom("room20000", { method: "GET", action: "reconcile", userId: 910001 });
  assert.equal(invalidJoinGet.status, 405);
  assert.equal(invalidReconcileGet.status, 405);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_rounds WHERE room_id='room20000'").count), Number(invalidGetBefore.count));

  // One-player round: use a dedicated account that was not part of the
  // concurrent 20-player round, so its prize payouts cannot race this balance check.
  // Repeated reconciliation must not issue a second refund or ledger entry.
  const soloUserId = 910022;
  const singleBefore = Number(one("SELECT balance FROM users WHERE id=" + soloUserId).balance);
  const single = await requestRoom("room10000", {
    method: "POST", action: "join", userId: soloUserId, idempotencyKey: "single-player-refund-0001",
    body: { cardsCount: 2, purchaseConfirmed: true, amount: 1 },
  });
  assert.equal(single.status, 200, JSON.stringify(single.data));
  assert.equal(Number(single.data.purchase.amount), 20_000, "Server price must override a forged client amount");
  assert.equal(Number(single.data.room.playerCount), 1);
  await waitForSnapshot("room10000", soloUserId, (room) => room.currentRoundStatus === "refunded", 30_000);

  const soloPurchaseId = String(single.data.purchase.id);
  assert.match(soloPurchaseId, /^[a-f0-9]{32}$/i, "Worker must return a safe purchase ID");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reconcile = await requestRoom("room10000", { method: "POST", action: "reconcile" });
    assert.equal(reconcile.status, 200, "Repeated reconcile must be accepted without replaying money");
  }

  const singleBalance = Number(one("SELECT balance FROM users WHERE id=" + soloUserId).balance);
  assert.equal(singleBalance, singleBefore, "Single-player refund must restore the exact original balance");
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_refunds WHERE purchase_id='" + soloPurchaseId + "'").count), 1,
    "Exactly one refund row must exist for the solo purchase");
  assert.equal(Number(one("SELECT amount FROM room_refunds WHERE purchase_id='" + soloPurchaseId + "'").amount), 20_000,
    "Refund amount must equal the exact purchase amount");
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_purchases WHERE id='" + soloPurchaseId + "' AND user_id=" + soloUserId + " AND room_id='room10000'").count), 1,
    "The solo account must own exactly one matching room purchase");
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM financial_ledger WHERE user_id=" + soloUserId + " AND operation='room_refund' AND reference_type='room_purchase' AND reference_id='" + soloPurchaseId + "'").count), 1,
    "Exactly one append-only refund ledger entry must exist");
  const soloRoundId = String(one("SELECT round_id FROM room_purchases WHERE id='" + soloPurchaseId + "'").round_id);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM transactions WHERE user_id=" + soloUserId + " AND type='room_refund' AND round_id='" + soloRoundId + "'").count), 1,
    "The refund transaction must reference its exact round");
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM transactions WHERE user_id=" + soloUserId + " AND type='room_refund' AND amount=20000 AND description=(SELECT 'بازپرداخت کامل دور تک‌نفره ' || round_id FROM room_refunds WHERE purchase_id='" + soloPurchaseId + "')").count), 1,
    "Exactly one refund transaction linked to the refunded round must exist");

  // A five-card purchase is valid, retries with the same key are replayed, a
  // changed payload is rejected, and a sixth card in that round is rejected.
  const firstBefore = Number(one("SELECT balance FROM users WHERE id=910023").balance);
  const first = await requestRoom("room5000", {
    method: "POST", action: "join", userId: 910023, idempotencyKey: "five-card-round-purchase-0001",
    body: { cardsCount: 5, purchaseConfirmed: true },
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(Number(first.data.purchase.amount), 25_000);
  assert.equal(first.data.room.myCards.length, 5);
  first.data.room.myCards.forEach(assertValidCard);
  const firstRoundId = String(first.data.purchase.roundId);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM transactions WHERE type='room_entry' AND round_id='" + firstRoundId + "'").count), 1,
    "The purchase transaction must reference its exact round");

  const replay = await requestRoom("room5000", {
    method: "POST", action: "join", userId: 910023, idempotencyKey: "five-card-round-purchase-0001",
    body: { cardsCount: 5, purchaseConfirmed: true },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.purchase.replayed, true);
  const changedPayload = await requestRoom("room5000", {
    method: "POST", action: "join", userId: 910023, idempotencyKey: "five-card-round-purchase-0001",
    body: { cardsCount: 4, purchaseConfirmed: true },
  });
  assert.equal(changedPayload.status, 409);
  const sixth = await requestRoom("room5000", {
    method: "POST", action: "join", userId: 910023, idempotencyKey: "sixth-card-must-fail-0001",
    body: { cardsCount: 1, purchaseConfirmed: true },
  });
  assert.equal(sixth.status, 409);
  assert.equal(Number(one("SELECT balance FROM users WHERE id=910023").balance), firstBefore - 25_000);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_purchases WHERE user_id=910023 AND room_id='room5000'").count), 1);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM transactions WHERE type='room_entry' AND round_id='" + firstRoundId + "'").count), 1,
    "Replaying a purchase must not create another round-linked debit transaction");

  const second = await requestRoom("room5000", {
    method: "POST", action: "join", userId: 910024, idempotencyKey: "second-player-round-0001",
    body: { cardsCount: 1, purchaseConfirmed: true },
  });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(Number(second.data.room.playerCount), 2);
  assert.equal(String(second.data.purchase.roundId), firstRoundId);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM transactions WHERE type='room_entry' AND round_id='" + firstRoundId + "'").count), 2,
    "Both players' entry transactions must reference the same round");

  // Force one identical card for two different users so the smoke test proves
  // simultaneous line/full winners are both recorded and share each prize.
  const sharedCard = JSON.stringify(second.data.room.myCards[0]).replace(/'/g, "''");
  const firstCardRow = one("SELECT id FROM room_cards WHERE round_id='" + firstRoundId + "' AND user_id=910023 ORDER BY card_number LIMIT 1");
  query("UPDATE room_cards SET card_json='" + sharedCard + "' WHERE id='" + firstCardRow.id + "'");

  // A concurrent duplicate using the same key must produce one debit and one
  // purchase record, even when the caller sends both requests simultaneously.
  const concurrentBefore = Number(one("SELECT balance FROM users WHERE id=910025").balance);
  const concurrent = await Promise.all([
    requestRoom("room20000", {
      method: "POST", action: "join", userId: 910025, idempotencyKey: "concurrent-identical-key-0001",
      body: { cardsCount: 2, purchaseConfirmed: true },
    }),
    requestRoom("room20000", {
      method: "POST", action: "join", userId: 910025, idempotencyKey: "concurrent-identical-key-0001",
      body: { cardsCount: 2, purchaseConfirmed: true },
    }),
  ]);
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [200, 200]);
  assert.equal(concurrent.filter((item) => item.data.purchase.replayed).length, 1);
  assert.equal(Number(one("SELECT balance FROM users WHERE id=910025").balance), concurrentBefore - 40_000);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_purchases WHERE user_id=910025 AND room_id='room20000'").count), 1);

  // The second round is accepted while the first game is playing. Once its
  // own 150-second-equivalent test deadline expires, it must wait in the queue.
  const firstPlaying = await waitForSnapshot("room5000", 910023, (room) => room.status === "playing", 30_000);
  assert.equal(firstPlaying.joined, true);
  assert.equal(firstPlaying.allPlayerCards.length, 6, "All six purchased cards must be visible to a player in the active round");
  assert.equal(new Set(firstPlaying.allPlayerCards.map((card) => card.playerName)).size, 2,
    "The active room view must include cards belonging to both participating players");
  const nextA = await requestRoom("room5000", {
    method: "POST", action: "join", userId: 910026, idempotencyKey: "future-round-player-a-0001",
    body: { cardsCount: 1, purchaseConfirmed: true },
  });
  assert.equal(nextA.status, 200, JSON.stringify(nextA.data));
  assert.equal(nextA.data.room.status, "playing");
  assert.equal(nextA.data.room.joined, false, "Future-round players must not be mistaken for current-round players");
  const nextB = await requestRoom("room5000", {
    method: "POST", action: "join", userId: 910027, idempotencyKey: "future-round-player-b-0001",
    body: { cardsCount: 1, purchaseConfirmed: true },
  });
  assert.equal(nextB.status, 200, JSON.stringify(nextB.data));
  assert.equal(nextB.data.room.status, "playing");

  const queued = await waitForSnapshot("room5000", 910026,
    (room) => room.status === "playing" && room.nextRound?.status === "waiting_for_room", 30_000);
  assert.equal(queued.nextRound.joined, true);
  assert.equal(queued.nextRound.playerCount, 2);
  assert.equal(queued.nextRound.myCards.length, 1);
  assert.equal(queued.joined, false, "A future-round player must not see themselves as playing now");

  // Simulate a Worker process restart while the first round is active. D1 and
  // Durable Object storage use the same local persistence path.
  const calledBeforeRestart = queued.allCalledNumbers.length;
  await stopWorker();
  startWorker();
  await waitForServer();
  await assertWorkerHealth();
  const afterRestart = await waitForSnapshot("room5000", 910023,
    (room) => room.status === "playing" && room.allCalledNumbers.length > calledBeforeRestart, 12_000);
  assert.ok(afterRestart.allCalledNumbers.length > calledBeforeRestart,
    "The game must resume from durable state after the Worker restarts");

  const round1Id = queued.roundId;
  const completed = await waitForSnapshot("room5000", 910026,
    (room) => (room.recentSessions || []).some((session) => session.roundId === round1Id), 75_000);
  const round1 = one("SELECT id,status,gross_revenue,line_prize_paid,full_prize_paid,site_commission,called_numbers_json,line_winners_json,full_winners_json FROM room_rounds WHERE room_id='room5000' AND sequence=1");
  assert.equal(round1.status, "completed");
  const lineWinners = JSON.parse(round1.line_winners_json);
  const fullWinners = JSON.parse(round1.full_winners_json);
  assert.deepEqual(lineWinners.map((winner) => Number(winner.userId)).sort((a, b) => a - b), [910023, 910024],
    "Both users with the same completed line must be recorded as simultaneous line winners");
  assert.deepEqual(fullWinners.map((winner) => Number(winner.userId)).sort((a, b) => a - b), [910023, 910024],
    "Both users with the same completed card must be recorded as simultaneous full winners");
  const gross = Number(round1.gross_revenue);
  assert.equal(gross, 30_000);
  assert.equal(Number(round1.line_prize_paid), Math.floor(gross * 10 / 100));
  assert.equal(Number(round1.full_prize_paid), Math.floor(gross * 75 / 100));
  assert.equal(Number(round1.site_commission), gross - Number(round1.line_prize_paid) - Number(round1.full_prize_paid));
  assert.equal(Number(round1.site_commission), Math.floor(gross * 15 / 100));
  const called = JSON.parse(round1.called_numbers_json);
  assert.equal(new Set(called).size, called.length, "A draw number must never repeat");
  assert.ok(called.every((number) => Number.isInteger(number) && number >= 1 && number <= 90));
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_payouts WHERE round_id='" + round1.id + "' AND prize_type='line'").count), 2);
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_payouts WHERE round_id='" + round1.id + "' AND prize_type='full'").count), 2);
  assert.equal(Number(one("SELECT SUM(amount) AS total FROM room_payouts WHERE round_id='" + round1.id + "' AND prize_type='line'").total), Number(round1.line_prize_paid),
    "The line prize must be split across every simultaneous winner without losing value");
  assert.equal(Number(one("SELECT SUM(amount) AS total FROM room_payouts WHERE round_id='" + round1.id + "' AND prize_type='full'").total), Number(round1.full_prize_paid),
    "The full prize must be split across every simultaneous winner without losing value");
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_finances WHERE round_id='" + round1.id + "'").count), 1);
  const payoutCount = Number(one("SELECT COUNT(*) AS count FROM room_payouts WHERE round_id='" + round1.id + "'").count);
  const payoutTransactionCount = Number(one("SELECT COUNT(*) AS count FROM transactions WHERE type='room_prize' AND round_id='" + round1.id + "'").count);
  assert.equal(payoutTransactionCount, payoutCount, "Every prize payout must have exactly one round-linked transaction");
  assert.equal(Number(one("SELECT COUNT(*) AS count FROM room_outbox WHERE round_id='" + round1.id + "' AND event_type='round.completed'").count), 1);
  assert.equal(completed.status, "playing", "A queued round must start after the current round completes");
  assert.equal(completed.joined, true);

  const playingCount = Number(one("SELECT COUNT(*) AS count FROM room_rounds WHERE room_id='room5000' AND status='playing'").count);
  assert.equal(playingCount, 1, "Only one game may be playing in a room at a time");
  const secondRound = one("SELECT status FROM room_rounds WHERE room_id='room5000' AND sequence=2");
  assert.equal(secondRound.status, "playing", "The oldest ready round must start first");

  // Verify the append-only database contract is enforced, not merely documented.
  const ledgerRow = one("SELECT id FROM financial_ledger WHERE user_id=910023 AND operation='room_purchase' LIMIT 1");
  let updateBlocked = false;
  try {
    query("UPDATE financial_ledger SET amount=amount WHERE id='" + String(ledgerRow.id).replace(/'/g, "''") + "'");
  } catch {
    updateBlocked = true;
  }
  assert.equal(updateBlocked, true, "Financial ledger UPDATE must be rejected by the database trigger");

  const unlinkedRoomTransactions = Number(one(
    "SELECT COUNT(*) AS count FROM transactions WHERE type IN ('room_entry','room_refund','room_prize') AND round_id IS NULL"
  ).count);
  assert.equal(unlinkedRoomTransactions, 0, "Every new room purchase, refund and prize transaction must link to its round");
  assert.equal(one("PRAGMA integrity_check").integrity_check, "ok", "The isolated D1 database must pass SQLite integrity_check");
  assert.equal(query("PRAGMA foreign_key_check").length, 0, "The isolated D1 database must have no foreign-key violations");

  console.log("Room coordinator integration checks passed: live health, GET read-only, server pricing, invalid six-card rejection, one-time refund, idempotent/concurrent purchases, 20-player capacity, five-card cap, simultaneous winners, exact payout splits, round-linked transactions, worker restart, and SQLite integrity.");
}

try {
  await main();
} catch (error) {
  failed = true;
  console.error(error);
  console.error("--- Local Durable Object Worker log ---");
  console.error(workerLog);
  process.exitCode = 1;
} finally {
  await stopWorker();
  await rm(persist, { recursive: true, force: true });
}
