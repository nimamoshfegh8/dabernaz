import { DurableObject } from "cloudflare:workers";

const ROOM_CONFIG = Object.freeze({
  room5000: { price: 5000, code: "DB-5000" },
  room10000: { price: 10000, code: "DB-10000" },
  room20000: { price: 20000, code: "DB-20000" },
  room50000: { price: 50000, code: "DB-50000" },
});
const REGISTRATION_WINDOW_MS = 150_000;
const MIN_PLAYERS = 2;
const MAX_CARDS_PER_PLAYER = 5;
const MAX_PLAYERS_PER_ROUND = 20;
const DRAW_INTERVAL_MS = 3_000;
const OUTBOX_LEASE_MS = 30_000;
const OUTBOX_MAX_ATTEMPTS = 20;

class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function configuredInterval(env, variable, fallback, minimum, maximum) {
  if (env.DABERNAZ_TEST_DIAGNOSTICS !== "1") return fallback;
  const value = Number(env[variable]);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function registrationWindowMs(env) {
  return configuredInterval(env, "DABERNAZ_TEST_REGISTRATION_WINDOW_MS", REGISTRATION_WINDOW_MS, 100, 150_000);
}

function drawIntervalMs(env) {
  return configuredInterval(env, "DABERNAZ_TEST_DRAW_INTERVAL_MS", DRAW_INTERVAL_MS, 10, 3_000);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function databaseHealth(db) {
  const [ping, migration, required] = await Promise.all([
    db.prepare("SELECT 1 AS ok").first(),
    db.prepare("SELECT MAX(version) AS version FROM schema_migrations").first(),
    db.prepare(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN " +
      "('users','transactions','schema_migrations','room_rounds','room_round_players','room_purchases','room_cards','room_refunds','room_payouts','room_player_stats','room_finances','room_outbox','financial_ledger','wallet_request_idempotency','tournament_entry_idempotency')"
    ).first(),
  ]);
  let transactionRoundLink = false;
  try {
    await db.prepare("SELECT round_id FROM transactions LIMIT 0").all();
    transactionRoundLink = true;
  } catch (_) {}
  const schemaVersion = Number(migration?.version) || 0;
  const requiredTables = Number(required?.total) || 0;
  const ready = Number(ping?.ok) === 1 && schemaVersion >= 4 &&
    requiredTables === 15 && transactionRoundLink;
  return {
    ok: ready,
    ready,
    database: "D1",
    schema: "v" + schemaVersion,
    requiredTables,
    transactionRoundLink,
  };
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function token() {
  return crypto.randomUUID().replace(/-/g, "");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secureRandomInt(maxExclusive) {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError("Invalid random integer range.");
  }
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / maxExclusive) * maxExclusive;
  const values = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(values);
    value = values[0];
  } while (value >= limit);
  return value % maxExclusive;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = secureRandomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function makeCard() {
  const grid = Array.from({ length: 3 }, () => Array(9).fill(false));
  for (let row = 0; row < 3; row += 1) {
    for (const col of shuffle(Array.from({ length: 9 }, (_, index) => index)).slice(0, 5)) {
      grid[row][col] = true;
    }
  }

  const counts = Array(9).fill(0);
  for (let col = 0; col < 9; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      if (grid[row][col]) counts[col] += 1;
    }
  }

  for (let missing = 0; missing < 9; missing += 1) {
    if (counts[missing] > 0) continue;
    const moves = [];
    for (let row = 0; row < 3; row += 1) {
      if (grid[row][missing]) continue;
      for (let donor = 0; donor < 9; donor += 1) {
        if (grid[row][donor] && counts[donor] > 1) moves.push([row, donor]);
      }
    }
    if (!moves.length) throw new Error("Card generation failed.");
    const [row, donor] = moves[secureRandomInt(moves.length)];
    grid[row][donor] = false;
    grid[row][missing] = true;
    counts[donor] -= 1;
    counts[missing] += 1;
  }

  const card = grid.map((row) => row.map((occupied) => occupied ? 0 : null));
  for (let col = 0; col < 9; col += 1) {
    const min = col === 0 ? 1 : col * 10;
    const max = col === 8 ? 90 : col * 10 + 9;
    const places = [];
    for (let row = 0; row < 3; row += 1) {
      if (card[row][col] === 0) places.push(row);
    }
    const values = shuffle(Array.from({ length: max - min + 1 }, (_, index) => min + index))
      .slice(0, places.length)
      .sort((a, b) => a - b);
    places.forEach((row, index) => { card[row][col] = values[index]; });
  }
  return card;
}

function lineComplete(card, calledSet) {
  return card.some((row) => {
    const values = row.filter(Number.isInteger);
    return values.length === 5 && values.every((value) => calledSet.has(value));
  });
}

function fullComplete(card, calledSet) {
  const values = card.flat().filter(Number.isInteger);
  return values.length === 15 && values.every((value) => calledSet.has(value));
}

function uniqueWinners(cards, calledSet, predicate, at) {
  const winners = new Map();
  for (const item of cards) {
    if (!predicate(item.card, calledSet) || winners.has(Number(item.user_id))) continue;
    winners.set(Number(item.user_id), {
      userId: Number(item.user_id),
      name: String(item.username_snapshot || "بازیکن"),
      memberId: String(item.member_id_snapshot || ""),
      number: calledSet.size,
      at,
    });
  }
  return [...winners.values()].sort((a, b) => a.userId - b.userId);
}

function splitAmounts(total, winners) {
  if (!winners.length || total <= 0) return [];
  const ordered = [...winners].sort((a, b) => a.userId - b.userId);
  const base = Math.floor(total / ordered.length);
  const remainder = total - base * ordered.length;
  return ordered.map((winner, index) => ({
    userId: winner.userId,
    amount: base + (index < remainder ? 1 : 0),
  })).filter((entry) => entry.amount > 0);
}

function publicWinners(value) {
  return parseArray(value).map((winner) => ({
    name: String(winner.name || "بازیکن"),
    memberId: String(winner.memberId || ""),
    number: Number(winner.number) || 0,
    at: Number(winner.at) || 0,
  }));
}

async function readJson(request, maxBytes = 8192) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RoomError(413, "درخواست بیش از حد بزرگ است.");
  }
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Expected object.");
    }
    return body;
  } catch {
    throw new RoomError(400, "ساختار درخواست معتبر نیست.");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "روش درخواست پشتیبانی نمی‌شود." }, 405);
      try {
        const dbHealth = await databaseHealth(env.DB);
        const stub = env.ROOMS.getByName("room5000");
        const response = await stub.fetch(new Request("https://room-coordinator/health", { method: "GET" }));
        const durableHealth = await response.json().catch(() => null);
        const durableReady = response.ok && durableHealth?.ready === true &&
          durableHealth?.transactionRoundLink === true;
        const ready = dbHealth.ready && durableReady;
        return json({
          ...dbHealth,
          ok: ready,
          ready,
          service: "dabernaz-room-coordinator",
          durableObject: {
            available: response.ok,
            ready: durableReady,
            schema: durableHealth?.schema || null,
          },
        }, ready ? 200 : 503);
      } catch (_) {
        return json({
          ok: false,
          ready: false,
          service: "dabernaz-room-coordinator",
          database: "unavailable",
          schema: "unknown",
          requiredTables: 0,
          transactionRoundLink: false,
          durableObject: { available: false, ready: false },
        }, 503);
      }
    }
    const match = url.pathname.match(/^\/rooms\/(room5000|room10000|room20000|room50000)(?:\/(join|next|leave|reconcile))?$/);
    if (!match) return json({ error: "مسیر اتاق پیدا نشد." }, 404);
    const [, roomId] = match;
    const object = env.ROOMS.getByName(roomId);
    const headers = new Headers(request.headers);
    headers.set("x-dabernaz-room-id", roomId);
    return object.fetch(new Request(request, { headers }));
  },

  async scheduled(_controller, env, ctx) {
    const result = await env.DB.prepare(
      "SELECT DISTINCT room_id FROM room_rounds WHERE status IN ('registration_open','ready','waiting_for_room','playing','refund_pending') " +
      "OR EXISTS (SELECT 1 FROM room_outbox o WHERE o.room_id=room_rounds.room_id AND o.status IN ('pending','processing'))"
    ).all();

    const rooms = (result.results || []).map((row) => String(row.room_id));
    const tasks = rooms.map((roomId) => {
      const stub = env.ROOMS.getByName(roomId);
      return stub.fetch(new Request("https://room-coordinator/rooms/" + roomId + "/reconcile", {
        method: "POST",
        headers: { "x-dabernaz-scheduler": "cron" },
      }));
    });

    ctx.waitUntil(Promise.allSettled(tasks));
  },
};

export class RoomCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.mutex = Promise.resolve();
  }

  async runExclusive(callback) {
    const previous = this.mutex;
    let release;
    this.mutex = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async fetch(request) {
    return this.runExclusive(async () => {
      try {
        const url = new URL(request.url);
        if (url.pathname === "/health" && request.method === "GET") {
          const health = await databaseHealth(this.env.DB);
          return json({ ...health, service: "dabernaz-room-coordinator-do" }, health.ready ? 200 : 503);
        }
        const match = url.pathname.match(/^\/rooms\/(room5000|room10000|room20000|room50000)(?:\/(join|next|leave|reconcile))?$/);
        if (!match) return json({ error: "مسیر اتاق پیدا نشد." }, 404);
        const [, roomId, action] = match;
        if (!ROOM_CONFIG[roomId]) return json({ error: "اتاق معتبر نیست." }, 404);
        // A GET to a mutation-only path must not touch Durable Object storage.
        // Persist the room ID only for actual POSTs which schedule reconciliation.
        if ((action === "join" || action === "reconcile") && request.method === "POST") {
          await this.ctx.storage.put("roomId", roomId);
        }

        if (!action && request.method === "GET") {
          const userId = Number(request.headers.get("x-dabernaz-user-id") || 0);
          return json({ ok: true, room: await this.snapshot(roomId, userId) });
        }

        if (action === "join" && request.method === "POST") {
          const userId = Number(request.headers.get("x-dabernaz-user-id") || 0);
          if (!Number.isSafeInteger(userId) || userId <= 0) {
            throw new RoomError(401, "برای خرید کارت ابتدا وارد حساب کاربری شو.");
          }
          const body = await readJson(request);
          const result = await this.purchase(roomId, userId, body, request.headers.get("idempotency-key") || "");
          await this.reconcileAndSchedule(roomId);
          return json({ ok: true, ...result });
        }

        if (action === "next" && request.method === "POST") {
          const userId = Number(request.headers.get("x-dabernaz-user-id") || 0);
          const room = await this.snapshot(roomId, userId);
          if (room.status !== "finished") return json({ ok: true, room });
          return json({ ok: true, room: this.emptyLobby(roomId) });
        }

        if (action === "leave" && request.method === "POST") {
          throw new RoomError(409, "خرید ثبت‌شده قابل لغو نیست؛ بازپرداخت فقط طبق وضعیت معتبر دور انجام می‌شود.");
        }

        if (action === "reconcile" && request.method === "POST") {
          await this.reconcileAndSchedule(roomId);
          return json({ ok: true, reconciled: true });
        }

        throw new RoomError(405, "روش درخواست برای این مسیر پشتیبانی نمی‌شود.");
      } catch (error) {
        const status = Number(error?.status) || 500;
        if (status >= 500) {
          console.error("[dabernaz-room-coordinator]", JSON.stringify({
            name: error?.name || "Error",
            message: String(error?.message || error),
            status,
          }));
        }
        return json({
          error: status >= 500 ? "خطای داخلی هماهنگ‌کننده اتاق رخ داد." : String(error.message || error),
        }, status);
      }
    });
  }

  emptyLobby(roomId) {
    const config = ROOM_CONFIG[roomId];
    return {
      id: roomId,
      status: "waiting",
      joined: false,
      playerCount: 0,
      queueCount: 0,
      cardCount: 0,
      capacity: MAX_PLAYERS_PER_ROUND,
      minPlayersToStart: MIN_PLAYERS,
      maxCardsPerPlayer: MAX_CARDS_PER_PLAYER,
      registrationStartedAt: null,
      registrationDeadline: null,
      registrationRemainingMs: null,
      grossRevenue: 0,
      estimatedPrizes: { line: 0, full: 0 },
      economics: {
        price: config.price,
        linePrizePercent: 10,
        fullPrizePercent: 75,
        commissionPercent: 15,
      },
      myCards: [],
      allPlayerCards: [],
      calledNumbers: [],
      allCalledNumbers: [],
      drawCount: 0,
      latestNumber: null,
      winners: { line: [], full: [] },
      players: [],
      nextRound: null,
      recentSessions: [],
    };
  }

  async purchase(roomId, userId, body, idempotencyKey) {
    const config = ROOM_CONFIG[roomId];
    const cardsCount = Number(body.cardsCount);
    if (body.purchaseConfirmed !== true) {
      throw new RoomError(400, "برای خرید کارت باید عملیات را صریحاً تأیید کنی.");
    }
    if (!Number.isSafeInteger(cardsCount) || cardsCount < 1 || cardsCount > MAX_CARDS_PER_PLAYER) {
      throw new RoomError(400, "تعداد کارت باید بین ۱ تا ۵ باشد.");
    }
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new RoomError(400, "کلید یکتای خرید معتبر نیست؛ دوباره تلاش کن.");
    }

    const requestHash = await sha256Hex(JSON.stringify({ roomId, userId, cardsCount }));
    const previous = await this.env.DB.prepare(
      "SELECT id,round_id,request_hash,card_count,amount FROM room_purchases WHERE user_id=? AND idempotency_key=?"
    ).bind(userId, idempotencyKey).first();

    if (previous) {
      if (previous.request_hash !== requestHash) {
        throw new RoomError(409, "این کلید درخواست قبلاً برای اطلاعات متفاوتی استفاده شده است.");
      }
      return {
        purchase: {
          id: previous.id,
          roundId: previous.round_id,
          cardsCount: Number(previous.card_count),
          amount: Number(previous.amount),
          replayed: true,
        },
        room: await this.snapshot(roomId, userId),
      };
    }

    await this.processDueRounds(roomId, Date.now());
    await this.startNextReadyRound(roomId, Date.now());

    const user = await this.env.DB.prepare(
      "SELECT id,username,member_id,balance FROM users WHERE id=?"
    ).bind(userId).first();
    if (!user) throw new RoomError(401, "حساب کاربری معتبر نیست.");

    let round = await this.env.DB.prepare(
      "SELECT * FROM room_rounds WHERE room_id=? AND status='registration_open' ORDER BY sequence DESC LIMIT 1"
    ).bind(roomId).first();

    const now = Date.now();
    const isNewRound = !round;
    const roundId = round ? String(round.id) : token();
    const purchaseId = token();
    const amount = config.price * cardsCount;

    const existingCardsRow = round
      ? await this.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM room_cards WHERE round_id=? AND user_id=?"
      ).bind(round.id, userId).first()
      : { count: 0 };
    const existingCards = Number(existingCardsRow?.count) || 0;
    if (existingCards + cardsCount > MAX_CARDS_PER_PLAYER) {
      throw new RoomError(409, "هر کاربر در هر دور حداکثر ۵ کارت می‌تواند داشته باشد.");
    }
    const playerCountRow = round
      ? await this.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM room_round_players WHERE round_id=?"
      ).bind(round.id).first()
      : { count: 0 };
    const playerCount = Number(playerCountRow?.count) || 0;
    if (existingCards === 0 && playerCount >= MAX_PLAYERS_PER_ROUND) {
      throw new RoomError(409, "ظرفیت ۲۰ بازیکن این دور تکمیل شده است.");
    }

    const sequenceRow = isNewRound
      ? await this.env.DB.prepare(
        "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM room_rounds WHERE room_id=?"
      ).bind(roomId).first()
      : null;
    const sequence = Number(sequenceRow?.sequence) || 1;
    const deadline = now + registrationWindowMs(this.env);
    const cards = Array.from({ length: cardsCount }, () => makeCard());
    // Debit only while the same registration window still accepts a
    // purchase. A deadline/capacity race must not leave money debited without
    // a corresponding durable purchase.
    const debit = isNewRound
      ? this.env.DB.prepare(
        "UPDATE users SET balance=balance-? WHERE id=? AND balance>=? " +
        "AND NOT EXISTS (SELECT 1 FROM room_rounds WHERE room_id=? AND status='registration_open')"
      ).bind(amount, userId, amount, roomId)
      : this.env.DB.prepare(
        "UPDATE users SET balance=balance-? WHERE id=? AND balance>=? " +
        "AND EXISTS (SELECT 1 FROM room_rounds r WHERE r.id=? AND r.room_id=? " +
        "AND r.status='registration_open' AND r.registration_deadline>? " +
        "AND (EXISTS (SELECT 1 FROM room_round_players p WHERE p.round_id=r.id AND p.user_id=?) " +
        "OR (SELECT COUNT(*) FROM room_round_players p WHERE p.round_id=r.id)<?))"
      ).bind(amount, userId, amount, roundId, roomId, now, userId, MAX_PLAYERS_PER_ROUND);
    const statements = [debit];

    if (isNewRound) {
      statements.push(
        this.env.DB.prepare(
          "INSERT INTO room_rounds(id,room_id,sequence,status,created_at,registration_started_at,registration_deadline) " +
          "SELECT ?,?,?,'registration_open',?,?,? WHERE changes()=1"
        ).bind(roundId, roomId, sequence, now, now, deadline),
        this.env.DB.prepare(
          "UPDATE room_rounds SET gross_revenue=gross_revenue+? WHERE id=? AND status='registration_open' AND changes()=1"
        ).bind(amount, roundId),
      );
    } else {
      statements.push(
        this.env.DB.prepare(
          "UPDATE room_rounds SET gross_revenue=gross_revenue+? WHERE id=? AND status='registration_open' AND registration_deadline>? AND changes()=1"
        ).bind(amount, roundId, now),
      );
    }

    statements.push(
      this.env.DB.prepare(
        "INSERT INTO room_purchases(id,round_id,room_id,user_id,idempotency_key,request_hash,card_count,unit_price,amount,created_at) " +
        "SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()=1"
      ).bind(purchaseId, roundId, roomId, userId, idempotencyKey, requestHash, cardsCount, config.price, amount, now),
      this.env.DB.prepare(
        "INSERT INTO room_round_players(round_id,user_id,username_snapshot,member_id_snapshot,cards_count,joined_at) " +
        "SELECT ?,id,username,COALESCE(member_id,''),?,? FROM users WHERE id=? " +
        "AND EXISTS (SELECT 1 FROM room_purchases WHERE id=?) " +
        "ON CONFLICT(round_id,user_id) DO UPDATE SET cards_count=room_round_players.cards_count+excluded.cards_count"
      ).bind(roundId, cardsCount, now, userId, purchaseId),
    );

    for (let index = 0; index < cards.length; index += 1) {
      statements.push(
        this.env.DB.prepare(
          "INSERT INTO room_cards(id,purchase_id,round_id,room_id,user_id,card_number,card_json,created_at) " +
          "SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM room_purchases WHERE id=?)"
        ).bind(token(), purchaseId, roundId, roomId, userId, existingCards + index + 1, JSON.stringify(cards[index]), now, purchaseId),
      );
    }

    statements.push(
      this.env.DB.prepare(
        "INSERT INTO transactions(user_id,type,amount,description,created_at,round_id) " +
        "SELECT ?,'room_entry',?,?,?,? WHERE EXISTS (SELECT 1 FROM room_purchases WHERE id=?)"
      ).bind(userId, -amount, "خرید کارت اتاق " + config.code, new Date(now).toISOString(), roundId, purchaseId),
      this.env.DB.prepare(
        "INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) " +
        "SELECT ?,?,'toman',?,'room_purchase','room_purchase',?,? WHERE EXISTS (SELECT 1 FROM room_purchases WHERE id=?)"
      ).bind(token(), userId, -amount, purchaseId, now, purchaseId),
      this.env.DB.prepare(
        "INSERT INTO room_outbox(event_id,room_id,round_id,event_type,payload_json,status,attempts,next_attempt_at,created_at) " +
        "SELECT ?,?,?, 'room.purchase.created',?,'pending',0,?,? WHERE EXISTS (SELECT 1 FROM room_purchases WHERE id=?)"
      ).bind(token(), roomId, roundId, JSON.stringify({ purchaseId, userId, cardsCount }), now, now, purchaseId),
    );

    let batch;
    try {
      batch = await this.env.DB.batch(statements);
    } catch (error) {
      const replay = await this.env.DB.prepare(
        "SELECT id,round_id,request_hash,card_count,amount FROM room_purchases WHERE user_id=? AND idempotency_key=?"
      ).bind(userId, idempotencyKey).first();
      if (replay && replay.request_hash === requestHash) {
        return {
          purchase: { id: replay.id, roundId: replay.round_id, cardsCount: Number(replay.card_count), amount: Number(replay.amount), replayed: true },
          room: await this.snapshot(roomId, userId),
        };
      }
      if (replay && replay.request_hash !== requestHash) {
        throw new RoomError(409, "این کلید درخواست قبلاً برای اطلاعات متفاوتی استفاده شده است.");
      }
      throw error;
    }

    const debitChanges = Number(batch?.[0]?.meta?.changes || 0);
    const purchaseResult = await this.env.DB.prepare(
      "SELECT id,round_id,card_count,amount FROM room_purchases WHERE id=? AND user_id=?"
    ).bind(purchaseId, userId).first();

    if (debitChanges !== 1 || !purchaseResult) {
      throw new RoomError(409, "موجودی کافی نیست یا مهلت ثبت‌نام تغییر کرده است؛ موجودی کیف پول را بررسی کن.");
    }

    return {
      purchase: {
        id: purchaseResult.id,
        roundId: purchaseResult.round_id,
        cardsCount: Number(purchaseResult.card_count),
        amount: Number(purchaseResult.amount),
        replayed: false,
      },
      room: await this.snapshot(roomId, userId),
    };
  }

  async processDueRounds(roomId, now) {
    const due = await this.env.DB.prepare(
      "SELECT id,status FROM room_rounds WHERE room_id=? AND status='registration_open' AND registration_deadline<=? ORDER BY sequence ASC"
    ).bind(roomId, now).all();

    for (const item of due.results || []) {
      const roundId = String(item.id);
      const totals = await this.env.DB.prepare(
        "SELECT COUNT(*) AS player_count FROM room_round_players WHERE round_id=?"
      ).bind(roundId).first();
      const playerCount = Number(totals?.player_count) || 0;

      if (playerCount === 0) {
        await this.env.DB.batch([
          this.env.DB.prepare(
            "UPDATE room_rounds SET status='cancelled',finished_at=? WHERE id=? AND status='registration_open' AND registration_deadline<=?"
          ).bind(now, roundId, now),
          this.env.DB.prepare(
            "INSERT INTO room_outbox(event_id,room_id,round_id,event_type,payload_json,status,attempts,next_attempt_at,created_at) " +
            "SELECT ?,room_id,id,'round.closed.empty',?,'pending',0,?,? FROM room_rounds WHERE id=? AND status='cancelled' " +
            "ON CONFLICT(event_id) DO NOTHING"
          ).bind(token(), JSON.stringify({ playerCount: 0 }), now, now, roundId),
        ]);
        continue;
      }

      if (playerCount === 1) {
        const purchases = await this.env.DB.prepare(
          "SELECT id,user_id,amount FROM room_purchases WHERE round_id=? ORDER BY created_at,id"
        ).bind(roundId).all();
        const statements = [
          this.env.DB.prepare(
            "UPDATE room_rounds SET status='refund_pending' WHERE id=? AND status='registration_open' AND registration_deadline<=?"
          ).bind(roundId, now),
        ];

        for (const purchase of purchases.results || []) {
          const refundId = token();
          statements.push(
            this.env.DB.prepare(
              "INSERT INTO room_refunds(id,purchase_id,round_id,user_id,amount,reason,created_at) " +
              "SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM room_rounds WHERE id=? AND status='refund_pending') " +
              "ON CONFLICT(purchase_id) DO NOTHING"
            ).bind(refundId, purchase.id, roundId, purchase.user_id, purchase.amount, "single_player_round_cancelled", now, roundId),
            this.env.DB.prepare(
              "UPDATE users SET balance=balance+? WHERE id=? AND changes()=1"
            ).bind(purchase.amount, purchase.user_id),
            this.env.DB.prepare(
              "INSERT INTO transactions(user_id,type,amount,description,created_at,round_id) " +
              "SELECT ?,'room_refund',?,?,?,?,? WHERE changes()=1"
            ).bind(purchase.user_id, purchase.amount, "بازپرداخت کامل دور تک‌نفره " + roundId, new Date(now).toISOString(), roundId),
            this.env.DB.prepare(
              "INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) " +
              "SELECT ?,?,'toman',?,'room_refund','room_purchase',?,? WHERE changes()=1"
            ).bind(token(), purchase.user_id, purchase.amount, purchase.id, now),
          );
        }

        statements.push(
          this.env.DB.prepare(
            "UPDATE room_rounds SET status='refunded',finished_at=? WHERE id=? AND status='refund_pending' " +
            "AND (SELECT COUNT(*) FROM room_refunds WHERE round_id=?)=(SELECT COUNT(*) FROM room_purchases WHERE round_id=?)"
          ).bind(now, roundId, roundId, roundId),
          this.env.DB.prepare(
            "INSERT INTO room_outbox(event_id,room_id,round_id,event_type,payload_json,status,attempts,next_attempt_at,created_at) " +
            "SELECT ?,room_id,id,'round.refunded',?,'pending',0,?,? FROM room_rounds WHERE id=? AND status='refunded' " +
            "ON CONFLICT(event_id) DO NOTHING"
          ).bind(token(), JSON.stringify({ playerCount: 1 }), now, now, roundId),
        );
        await this.env.DB.batch(statements);
        continue;
      }

      const active = await this.env.DB.prepare(
        "SELECT id FROM room_rounds WHERE room_id=? AND status='playing' LIMIT 1"
      ).bind(roomId).first();
      const targetStatus = active ? "waiting_for_room" : "ready";
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE room_rounds SET status=?,ready_at=? WHERE id=? AND status='registration_open' AND registration_deadline<=?"
        ).bind(targetStatus, now, roundId, now),
        this.env.DB.prepare(
          "INSERT INTO room_outbox(event_id,room_id,round_id,event_type,payload_json,status,attempts,next_attempt_at,created_at) " +
          "SELECT ?,room_id,id,'round.registration.ready',?,'pending',0,?,? FROM room_rounds WHERE id=? AND status IN ('ready','waiting_for_room') " +
          "ON CONFLICT(event_id) DO NOTHING"
        ).bind(token(), JSON.stringify({ playerCount }), now, now, roundId),
      ]);
    }
  }

  async startNextReadyRound(roomId, now) {
    const active = await this.env.DB.prepare(
      "SELECT id FROM room_rounds WHERE room_id=? AND status='playing' LIMIT 1"
    ).bind(roomId).first();
    if (active) return false;

    const next = await this.env.DB.prepare(
      "SELECT id FROM room_rounds WHERE room_id=? AND status IN ('ready','waiting_for_room') ORDER BY sequence ASC LIMIT 1"
    ).bind(roomId).first();
    if (!next) return false;

    const started = await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE room_rounds SET status='playing',started_at=?,next_draw_at=? " +
        "WHERE id=? AND status IN ('ready','waiting_for_room') " +
        "AND NOT EXISTS (SELECT 1 FROM room_rounds WHERE room_id=? AND status='playing')"
      ).bind(now, now + drawIntervalMs(this.env), next.id, roomId),
      this.env.DB.prepare(
        "INSERT INTO room_outbox(event_id,room_id,round_id,event_type,payload_json,status,attempts,next_attempt_at,created_at) " +
        "SELECT ?,room_id,id,'round.started',?,'pending',0,?,? FROM room_rounds WHERE id=? AND status='playing' " +
        "ON CONFLICT(event_id) DO NOTHING"
      ).bind(token(), JSON.stringify({ startedAt: now }), now, now, next.id),
    ]);
    return Number(started?.[0]?.meta?.changes || 0) === 1;
  }

  async advancePlayingRound(roomId, now) {
    const round = await this.env.DB.prepare(
      "SELECT * FROM room_rounds WHERE room_id=? AND status='playing' AND next_draw_at<=? ORDER BY sequence ASC LIMIT 1"
    ).bind(roomId, now).first();
    if (!round) return false;

    const previousCalled = parseArray(round.called_numbers_json);
    const remaining = Array.from({ length: 90 }, (_, index) => index + 1)
      .filter((number) => !previousCalled.includes(number));
    const newCalled = [...previousCalled];
    if (remaining.length) newCalled.push(remaining[secureRandomInt(remaining.length)]);

    const calledSet = new Set(newCalled);
    const cardRows = await this.env.DB.prepare(
      "SELECT c.user_id,c.card_json,p.username_snapshot,p.member_id_snapshot " +
      "FROM room_cards c JOIN room_round_players p ON p.round_id=c.round_id AND p.user_id=c.user_id " +
      "WHERE c.round_id=? ORDER BY c.user_id,c.card_number"
    ).bind(round.id).all();
    const cards = (cardRows.results || []).map((row) => ({
      user_id: Number(row.user_id),
      username_snapshot: row.username_snapshot,
      member_id_snapshot: row.member_id_snapshot,
      card: JSON.parse(row.card_json),
    }));

    const drawAt = now;
    const priorLine = parseArray(round.line_winners_json);
    const priorFull = parseArray(round.full_winners_json);
    const lineWinners = priorLine.length ? priorLine : uniqueWinners(cards, calledSet, lineComplete, drawAt);
    const fullWinners = priorFull.length ? priorFull : uniqueWinners(cards, calledSet, fullComplete, drawAt);
    const gross = Number(round.gross_revenue) || 0;
    const linePrize = lineWinners.length ? Math.floor(gross * 10 / 100) : Number(round.line_prize_paid) || 0;
    const fullPrize = fullWinners.length ? Math.floor(gross * 75 / 100) : Number(round.full_prize_paid) || 0;
    const finished = (lineWinners.length > 0 && fullWinners.length > 0) || newCalled.length >= 90;
    const commission = finished ? gross - linePrize - fullPrize : 0;
    const lineJson = JSON.stringify(lineWinners);
    const fullJson = JSON.stringify(fullWinners);
    const calledJson = JSON.stringify(newCalled);
    const lineChanged = !priorLine.length && lineWinners.length > 0;
    const fullChanged = !priorFull.length && fullWinners.length > 0;

    const statements = [
      this.env.DB.prepare(
        "UPDATE room_rounds SET called_numbers_json=?,line_winners_json=?,full_winners_json=?," +
        "line_prize_paid=?,full_prize_paid=?,site_commission=?,status=?,next_draw_at=?,finished_at=? " +
        "WHERE id=? AND status='playing' AND called_numbers_json=?"
      ).bind(
        calledJson, lineJson, fullJson, linePrize, fullPrize, commission,
        finished ? "completed" : "playing",
        finished ? null : now + drawIntervalMs(this.env),
        finished ? now : null,
        round.id, String(round.called_numbers_json || "[]"),
      ),
    ];

    const appendPayout = (kind, winners, prize, changed) => {
      if (!changed || prize <= 0 || !winners.length) return;
      for (const allocation of splitAmounts(prize, winners)) {
        statements.push(
          this.env.DB.prepare(
            "INSERT INTO room_payouts(id,round_id,user_id,prize_type,amount,created_at) " +
            "SELECT ?,?,?,?, ?,? WHERE EXISTS (SELECT 1 FROM room_rounds WHERE id=? AND called_numbers_json=? " +
            "AND status IN ('playing','completed')) ON CONFLICT(round_id,prize_type,user_id) DO NOTHING"
          ).bind(token(), round.id, allocation.userId, kind, allocation.amount, now, round.id, calledJson),
          this.env.DB.prepare(
            "UPDATE users SET balance=balance+? WHERE id=? AND changes()=1"
          ).bind(allocation.amount, allocation.userId),
          this.env.DB.prepare(
            "INSERT INTO transactions(user_id,type,amount,description,created_at,round_id) SELECT ?,'room_prize',?,?,?,?,? WHERE changes()=1"
          ).bind(allocation.userId, allocation.amount, kind === "line" ? "جایزه برنده خطی" : "جایزه برنده کامل", new Date(now).toISOString(), round.id),
          this.env.DB.prepare(
            "INSERT INTO financial_ledger(id,user_id,asset,amount,operation,reference_type,reference_id,created_at) " +
            "SELECT ?,?,'toman',?,'room_prize',?,?,? WHERE changes()=1"
          ).bind(token(), allocation.userId, allocation.amount, "room_round_" + kind, round.id, now),
        );
      }
    };

    appendPayout("line", lineWinners, linePrize, lineChanged);
    appendPayout("full", fullWinners, fullPrize, fullChanged);

    if (finished) {
      statements.push(
        this.env.DB.prepare(
          "INSERT INTO room_finances(round_id,room_id,total_players,total_cards,gross_revenue,line_prize_paid,full_prize_paid,site_commission,line_winners_json,full_winners_json,finished_at,created_at) " +
          "SELECT ?,?,?,(SELECT COUNT(*) FROM room_cards WHERE round_id=?),?,?,?,?,?,?,?,? " +
          "WHERE EXISTS (SELECT 1 FROM room_rounds WHERE id=? AND status='completed' AND called_numbers_json=?) " +
          "ON CONFLICT(round_id) DO NOTHING"
        ).bind(
          round.id, roomId, Number((await this.env.DB.prepare("SELECT COUNT(*) AS count FROM room_round_players WHERE round_id=?").bind(round.id).first())?.count) || 0,
          round.id, gross, linePrize, fullPrize, commission, lineJson, fullJson,
          new Date(now).toISOString(), new Date(now).toISOString(), round.id, calledJson,
        ),
        this.env.DB.prepare(
          "UPDATE room_rounds SET finance_finalized=1 WHERE id=? AND status='completed' AND finance_finalized=0"
        ).bind(round.id),
      );

      const playerRows = await this.env.DB.prepare(
        "SELECT user_id FROM room_round_players WHERE round_id=? ORDER BY user_id"
      ).bind(round.id).all();
      const winnerIds = new Set([...lineWinners, ...fullWinners].map((winner) => Number(winner.userId)));
      for (const player of playerRows.results || []) {
        const userId = Number(player.user_id);
        statements.push(
          this.env.DB.prepare(
            "INSERT INTO room_player_stats(round_id,user_id,result,created_at) VALUES(?,?,?,?) ON CONFLICT(round_id,user_id) DO NOTHING"
          ).bind(round.id, userId, winnerIds.has(userId) ? "won" : "lost", now),
          this.env.DB.prepare(
            "UPDATE users SET games_played=games_played+1,wins=wins+?,points=points+? WHERE id=? AND changes()=1"
          ).bind(winnerIds.has(userId) ? 1 : 0, winnerIds.has(userId) ? 10 : 0, userId),
        );
      }

      statements.push(
        this.env.DB.prepare(
          "INSERT INTO room_outbox(event_id,room_id,round_id,event_type,payload_json,status,attempts,next_attempt_at,created_at) " +
          "SELECT ?,room_id,id,'round.completed',?,'pending',0,?,? FROM room_rounds WHERE id=? AND status='completed' " +
          "ON CONFLICT(event_id) DO NOTHING"
        ).bind(token(), JSON.stringify({ lineWinners, fullWinners, gross, commission }), now, now, round.id),
      );
    }

    const result = await this.env.DB.batch(statements);
    const changed = Number(result?.[0]?.meta?.changes || 0) === 1;
    if (finished && changed) await this.startNextReadyRound(roomId, now);
    return changed;
  }

  async drainOutbox(roomId, now) {
    const rows = await this.env.DB.prepare(
      "SELECT id,event_type,round_id,attempts FROM room_outbox WHERE room_id=? " +
      "AND (status='pending' OR (status='processing' AND COALESCE(lease_until,0)<=?)) " +
      "AND next_attempt_at<=? ORDER BY id ASC LIMIT 50"
    ).bind(roomId, now, now).all();

    for (const event of rows.results || []) {
      const attempts = Number(event.attempts) + 1;
      await this.env.DB.prepare(
        "UPDATE room_outbox SET status='processing',attempts=?,lease_until=? WHERE id=? " +
        "AND (status='pending' OR (status='processing' AND COALESCE(lease_until,0)<=?))"
      ).bind(attempts, now + OUTBOX_LEASE_MS, event.id, now).run();

      try {
        // The coordinator's durable state is D1. Acknowledgement means the
        // event has been observed and the per-room alarm has been reconciled.
        await this.scheduleNextAlarm(roomId);
        await this.env.DB.prepare(
          "UPDATE room_outbox SET status='delivered',lease_until=NULL,last_error=NULL,delivered_at=? WHERE id=? AND status='processing'"
        ).bind(now, event.id).run();
      } catch (error) {
        const dead = attempts >= OUTBOX_MAX_ATTEMPTS;
        const delay = Math.min(60_000 * (2 ** Math.min(attempts, 6)), 60 * 60 * 1000);
        await this.env.DB.prepare(
          "UPDATE room_outbox SET status=?,lease_until=NULL,next_attempt_at=?,last_error=? WHERE id=? AND status='processing'"
        ).bind(
          dead ? "dead_letter" : "pending",
          now + delay,
          String(error?.message || error).slice(0, 300),
          event.id,
        ).run();
      }
    }
  }

  async reconcileAndSchedule(roomId) {
    const now = Date.now();
    await this.processDueRounds(roomId, now);
    await this.startNextReadyRound(roomId, now);
    const playing = await this.advancePlayingRound(roomId, now);
    if (playing) await this.startNextReadyRound(roomId, Date.now());
    await this.drainOutbox(roomId, Date.now());
    await this.scheduleNextAlarm(roomId);
  }

  async scheduleNextAlarm(roomId) {
    const deadlines = await this.env.DB.prepare(
      "SELECT MIN(registration_deadline) AS next_at FROM room_rounds WHERE room_id=? AND status='registration_open'"
    ).bind(roomId).first();
    const draws = await this.env.DB.prepare(
      "SELECT MIN(next_draw_at) AS next_at FROM room_rounds WHERE room_id=? AND status='playing'"
    ).bind(roomId).first();
    const outbox = await this.env.DB.prepare(
      "SELECT MIN(CASE WHEN status='processing' THEN COALESCE(lease_until,next_attempt_at) ELSE next_attempt_at END) AS next_at " +
      "FROM room_outbox WHERE room_id=? AND status IN ('pending','processing')"
    ).bind(roomId).first();
    const values = [
      Number(deadlines?.next_at) || null,
      Number(draws?.next_at) || null,
      Number(outbox?.next_at) || null,
    ].filter((value) => value !== null);
    if (!values.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const nextAt = Math.max(Date.now() + 250, Math.min(...values));
    await this.ctx.storage.setAlarm(nextAt);
  }

  async alarm() {
    await this.runExclusive(async () => {
      try {
        const roomId = await this.ctx.storage.get("roomId");
        if (typeof roomId === "string" && ROOM_CONFIG[roomId]) {
          await this.reconcileAndSchedule(roomId);
        }
      } catch (error) {
        console.error("[dabernaz-room-alarm]", JSON.stringify({
          message: String(error?.message || error),
        }));
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
      }
    });
  }

  async snapshot(roomId, userId) {
    const [playing, registration, waiting, latest] = await Promise.all([
      this.env.DB.prepare("SELECT * FROM room_rounds WHERE room_id=? AND status='playing' LIMIT 1").bind(roomId).first(),
      this.env.DB.prepare("SELECT * FROM room_rounds WHERE room_id=? AND status='registration_open' ORDER BY sequence DESC LIMIT 1").bind(roomId).first(),
      this.env.DB.prepare("SELECT * FROM room_rounds WHERE room_id=? AND status IN ('ready','waiting_for_room') ORDER BY sequence ASC LIMIT 1").bind(roomId).first(),
      this.env.DB.prepare("SELECT * FROM room_rounds WHERE room_id=? ORDER BY sequence DESC LIMIT 1").bind(roomId).first(),
    ]);

    const config = ROOM_CONFIG[roomId];
    const primary = playing || registration || waiting || latest;
    if (!primary) return this.emptyLobby(roomId);

    const activeRound = playing || registration || waiting || latest;
    const activePlayers = await this.env.DB.prepare(
      "SELECT user_id,username_snapshot,member_id_snapshot,cards_count FROM room_round_players WHERE round_id=? ORDER BY joined_at,user_id"
    ).bind(activeRound.id).all();
    const activeUser = Number(userId) > 0
      ? await this.env.DB.prepare("SELECT 1 AS yes FROM room_round_players WHERE round_id=? AND user_id=?")
        .bind(activeRound.id, userId).first()
      : null;
    const activeCards = await this.cardsForRound(activeRound.id);
    const nextRoundRecord = playing ? (registration || waiting) : null;
    const next = nextRoundRecord ? await this.roundSummary(nextRoundRecord, userId) : null;

    const userIsPlaying = Boolean(playing && activeUser);
    const userIsRegistered = Boolean(!playing && activeUser);
    const userIsQueuedNext = Boolean(next?.joined);
    const displayCards = playing
      ? (userIsPlaying ? activeCards.filter((item) => Number(item.userId) === Number(userId)).map((item) => item.card) : (next?.myCards || []))
      : (activeUser ? activeCards.filter((item) => Number(item.userId) === Number(userId)).map((item) => item.card) : []);

    const displayRound = playing || registration || waiting || latest;
    const registrationRound = playing ? registration : (registration || waiting);
    const queuePlayers = registrationRound
      ? await this.env.DB.prepare("SELECT COUNT(*) AS count FROM room_round_players WHERE round_id=?").bind(registrationRound.id).first()
      : null;
    const queueCards = registrationRound
      ? await this.env.DB.prepare("SELECT COUNT(*) AS count FROM room_cards WHERE round_id=?").bind(registrationRound.id).first()
      : null;

    const allPlayerCards = userIsPlaying
      ? activeCards.map((item) => ({
        playerName: item.playerName,
        memberId: item.memberId,
        cardNumber: item.cardNumber,
        card: item.card,
      }))
      : [];

    const called = parseArray(displayRound.called_numbers_json);
    const line = publicWinners(displayRound.line_winners_json);
    const full = publicWinners(displayRound.full_winners_json);
    const gross = Number(registrationRound?.gross_revenue ?? displayRound.gross_revenue) || 0;
    const registrationDeadline = registrationRound ? Number(registrationRound.registration_deadline) : null;
    const isFinished = !playing && !registration && !waiting && latest?.status === "completed";
    const status = playing ? "playing" : isFinished ? "finished" : "waiting";
    const playerCount = Number(queuePlayers?.count ?? activePlayers.results?.length ?? 0) || 0;
    const cardCount = Number(queueCards?.count ?? activeCards.length) || 0;

    const recent = await this.env.DB.prepare(
      "SELECT round_id,room_id,total_players,total_cards,gross_revenue,line_prize_paid,full_prize_paid,site_commission," +
      "line_winners_json,full_winners_json,finished_at FROM room_finances WHERE room_id=? ORDER BY id DESC LIMIT 12"
    ).bind(roomId).all();

    return {
      id: roomId,
      status,
      joined: playing ? userIsPlaying : (userIsRegistered || userIsQueuedNext),
      playerCount,
      queueCount: playerCount,
      cardCount,
      capacity: MAX_PLAYERS_PER_ROUND,
      minPlayersToStart: MIN_PLAYERS,
      maxCardsPerPlayer: MAX_CARDS_PER_PLAYER,
      registrationStartedAt: registrationRound ? Number(registrationRound.registration_started_at) : null,
      registrationDeadline,
      registrationRemainingMs: registrationDeadline ? Math.max(0, registrationDeadline - Date.now()) : null,
      grossRevenue: gross,
      estimatedPrizes: {
        line: Math.floor(gross * 10 / 100),
        full: Math.floor(gross * 75 / 100),
      },
      economics: {
        price: config.price,
        linePrizePercent: 10,
        fullPrizePercent: 75,
        commissionPercent: 15,
      },
      roundId: displayRound.id,
      myCards: displayCards,
      allPlayerCards,
      calledNumbers: called.slice(-15),
      allCalledNumbers: called,
      drawCount: called.length,
      latestNumber: called.length ? called[called.length - 1] : null,
      winners: { line, full },
      players: (activePlayers.results || []).map((player) => ({
        name: String(player.username_snapshot || "بازیکن"),
        memberId: String(player.member_id_snapshot || ""),
        cardCount: Number(player.cards_count) || 0,
      })),
      nextRound: next,
      myBingoCoins: null,
      recentSessions: (recent.results || []).map((session) => ({
        roundId: session.round_id,
        lineWinners: publicWinners(session.line_winners_json),
        fullWinners: publicWinners(session.full_winners_json),
        grossRevenue: Number(session.gross_revenue) || 0,
        finishedAt: session.finished_at,
      })),
      currentRoundStatus: displayRound.status,
    };
  }

  async roundSummary(round, userId) {
    const [players, cards, me] = await Promise.all([
      this.env.DB.prepare("SELECT COUNT(*) AS count FROM room_round_players WHERE round_id=?").bind(round.id).first(),
      this.env.DB.prepare("SELECT COUNT(*) AS count FROM room_cards WHERE round_id=?").bind(round.id).first(),
      Number(userId) > 0
        ? this.env.DB.prepare("SELECT 1 AS yes FROM room_round_players WHERE round_id=? AND user_id=?").bind(round.id, userId).first()
        : Promise.resolve(null),
    ]);
    const ownCards = Number(userId) > 0
      ? await this.env.DB.prepare("SELECT card_json FROM room_cards WHERE round_id=? AND user_id=? ORDER BY card_number")
        .bind(round.id, userId).all()
      : { results: [] };
    const deadline = Number(round.registration_deadline);
    const gross = Number(round.gross_revenue) || 0;
    return {
      id: round.id,
      status: round.status,
      playerCount: Number(players?.count) || 0,
      cardCount: Number(cards?.count) || 0,
      registrationDeadline: deadline,
      registrationRemainingMs: Math.max(0, deadline - Date.now()),
      grossRevenue: gross,
      estimatedPrizes: { line: Math.floor(gross * 10 / 100), full: Math.floor(gross * 75 / 100) },
      joined: Boolean(me),
      myCards: (ownCards.results || []).map((row) => JSON.parse(row.card_json)),
    };
  }

  async cardsForRound(roundId) {
    const rows = await this.env.DB.prepare(
      "SELECT c.user_id,c.card_number,c.card_json,p.username_snapshot,p.member_id_snapshot " +
      "FROM room_cards c JOIN room_round_players p ON p.round_id=c.round_id AND p.user_id=c.user_id " +
      "WHERE c.round_id=? ORDER BY c.user_id,c.card_number"
    ).bind(roundId).all();
    return (rows.results || []).map((row) => ({
      userId: Number(row.user_id),
      playerName: String(row.username_snapshot || "بازیکن"),
      memberId: String(row.member_id_snapshot || ""),
      cardNumber: Number(row.card_number),
      card: JSON.parse(row.card_json),
    }));
  }
}
