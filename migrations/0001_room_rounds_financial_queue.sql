-- Dabernaz normalized room rounds, idempotent purchases, append-only ledger,
-- unique refunds/payouts, and durable event outbox.
-- Additive only. Does not rewrite or delete legacy room_states/room_finances data.
CREATE TABLE IF NOT EXISTS room_rounds (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL CHECK (room_id IN ('room5000','room10000','room20000','room50000')),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN (
    'registration_open','ready','waiting_for_room','playing',
    'completed','cancelled','refund_pending','refunded'
  )),
  created_at INTEGER NOT NULL,
  registration_started_at INTEGER NOT NULL,
  registration_deadline INTEGER NOT NULL,
  ready_at INTEGER,
  started_at INTEGER,
  next_draw_at INTEGER,
  finished_at INTEGER,
  called_numbers_json TEXT NOT NULL DEFAULT '[]',
  line_winners_json TEXT NOT NULL DEFAULT '[]',
  full_winners_json TEXT NOT NULL DEFAULT '[]',
  gross_revenue INTEGER NOT NULL DEFAULT 0 CHECK (gross_revenue >= 0),
  line_prize_paid INTEGER NOT NULL DEFAULT 0 CHECK (line_prize_paid >= 0),
  full_prize_paid INTEGER NOT NULL DEFAULT 0 CHECK (full_prize_paid >= 0),
  site_commission INTEGER NOT NULL DEFAULT 0 CHECK (site_commission >= 0),
  finance_finalized INTEGER NOT NULL DEFAULT 0 CHECK (finance_finalized IN (0,1)),
  stats_recorded INTEGER NOT NULL DEFAULT 0 CHECK (stats_recorded IN (0,1)),
  UNIQUE (room_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_room_rounds_queue
  ON room_rounds(room_id, status, sequence);

CREATE INDEX IF NOT EXISTS idx_room_rounds_deadline
  ON room_rounds(status, registration_deadline);

CREATE TABLE IF NOT EXISTS room_round_players (
  round_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  username_snapshot TEXT NOT NULL,
  member_id_snapshot TEXT NOT NULL DEFAULT '',
  cards_count INTEGER NOT NULL DEFAULT 0 CHECK (cards_count BETWEEN 0 AND 5),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, user_id),
  FOREIGN KEY (round_id) REFERENCES room_rounds(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_room_round_players_user
  ON room_round_players(user_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS room_purchases (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  card_count INTEGER NOT NULL CHECK (card_count BETWEEN 1 AND 5),
  unit_price INTEGER NOT NULL CHECK (unit_price > 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (round_id) REFERENCES room_rounds(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_room_purchases_round
  ON room_purchases(round_id, created_at);

CREATE TABLE IF NOT EXISTS room_cards (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  card_number INTEGER NOT NULL CHECK (card_number BETWEEN 1 AND 5),
  card_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (purchase_id, card_number),
  FOREIGN KEY (purchase_id) REFERENCES room_purchases(id) ON DELETE RESTRICT,
  FOREIGN KEY (round_id) REFERENCES room_rounds(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_room_cards_round_user
  ON room_cards(round_id, user_id, card_number);

CREATE TABLE IF NOT EXISTS room_refunds (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE,
  round_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (purchase_id) REFERENCES room_purchases(id) ON DELETE RESTRICT,
  FOREIGN KEY (round_id) REFERENCES room_rounds(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS room_payouts (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  prize_type TEXT NOT NULL CHECK (prize_type IN ('line','full')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at INTEGER NOT NULL,
  UNIQUE (round_id, prize_type, user_id),
  FOREIGN KEY (round_id) REFERENCES room_rounds(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS room_player_stats (
  round_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('won','lost')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, user_id),
  FOREIGN KEY (round_id) REFERENCES room_rounds(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- This ledger is append-only by application contract. Each business effect can
-- be represented at most once for a specific user and reference.

-- A milestone can be rewarded only once even when several invitations register
-- concurrently. The claim is the idempotency guard for the financial effect.
CREATE TABLE IF NOT EXISTS referral_reward_claims (
  inviter_id INTEGER NOT NULL,
  milestone INTEGER NOT NULL CHECK (milestone > 0),
  referral_count INTEGER NOT NULL CHECK (referral_count > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (inviter_id, milestone),
  FOREIGN KEY (inviter_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS wallet_adjustment_requests (
  id TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  target_user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK (amount <> 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected')),
  created_at INTEGER NOT NULL,
  UNIQUE (admin_user_id, idempotency_key),
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_wallet_adjustment_target
  ON wallet_adjustment_requests(target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS financial_ledger (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('toman','bingo_coin')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  operation TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (asset, operation, reference_type, reference_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_financial_ledger_user_time
  ON financial_ledger(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS room_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','delivered','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  FOREIGN KEY (round_id) REFERENCES room_rounds(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_room_outbox_due
  ON room_outbox(status, next_attempt_at, lease_until);

-- At most one registration window may be open in a room at a time. When it
-- expires, the next purchase may create another independent future round.
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_rounds_one_open_registration
  ON room_rounds(room_id) WHERE status='registration_open';

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_rounds_one_playing
  ON room_rounds(room_id) WHERE status='playing';

-- Protect the ledger from mutation and record the completed schema version.
CREATE TRIGGER IF NOT EXISTS financial_ledger_no_update
BEFORE UPDATE ON financial_ledger
BEGIN
  SELECT RAISE(ABORT, 'financial_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS financial_ledger_no_delete
BEFORE DELETE ON financial_ledger
BEGIN
  SELECT RAISE(ABORT, 'financial_ledger is append-only');
END;

INSERT OR IGNORE INTO schema_migrations(version,name)
VALUES (1,'room_rounds_financial_queue');
