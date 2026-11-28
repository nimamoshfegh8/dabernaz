-- Dabernaz core schema, version 0.
-- Additive, idempotent schema bootstrap for a fresh Preview D1 database.
-- Existing tables and user data are preserved by CREATE TABLE/INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO schema_migrations(version,name) VALUES (0,'core_schema');

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  bingo_coins INTEGER NOT NULL DEFAULT 0,
  referral_code TEXT UNIQUE,
  referred_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  email TEXT,
  member_id TEXT,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_member_id ON users(member_id) WHERE member_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_type ON transactions(user_id,type,id DESC);

CREATE TABLE IF NOT EXISTS game_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  game_type TEXT NOT NULL,
  result TEXT NOT NULL,
  prize INTEGER NOT NULL DEFAULT 0,
  bingo_coins_earned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_game_results_user ON game_results(user_id,id DESC);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER NOT NULL,
  invited_user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (inviter_id) REFERENCES users(id),
  FOREIGN KEY (invited_user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_invited ON referrals(invited_user_id);

CREATE TABLE IF NOT EXISTS game_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entry_fee INTEGER NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  game_type TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'playing',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_game_sessions_user_status ON game_sessions(user_id,status,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_sessions_one_active
  ON game_sessions(user_id,game_type) WHERE status='playing';

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  email TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_lookup ON auth_attempts(ip,email,attempted_at);

-- Legacy room tables remain for the Node/PHP fallback and safe read-only history
-- migration. The new Cloudflare room engine uses normalized room_rounds tables.
CREATE TABLE IF NOT EXISTS room_states (
  room_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_locks (
  room_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_finances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  total_players INTEGER NOT NULL,
  total_cards INTEGER NOT NULL,
  gross_revenue INTEGER NOT NULL,
  line_prize_paid INTEGER NOT NULL,
  full_prize_paid INTEGER NOT NULL,
  site_commission INTEGER NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  line_winners_json TEXT NOT NULL DEFAULT '[]',
  full_winners_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_room_finances_room_created ON room_finances(room_id,id DESC);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id,id DESC);

CREATE TABLE IF NOT EXISTS wallet_payment_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  card_number TEXT NOT NULL DEFAULT '',
  card_holder TEXT NOT NULL DEFAULT '',
  bank_name TEXT NOT NULL DEFAULT '',
  payment_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user','admin')),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_messages_user ON wallet_messages(user_id,id DESC);

CREATE TABLE IF NOT EXISTS manual_wallet_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN ('deposit','withdraw')),
  amount INTEGER NOT NULL CHECK(amount>0),
  status TEXT NOT NULL,
  receipt_data_url TEXT,
  receipt_mime TEXT,
  card_number TEXT,
  card_holder TEXT,
  bank_name TEXT,
  user_note TEXT NOT NULL DEFAULT '',
  payment_card_number TEXT NOT NULL DEFAULT '',
  payment_card_holder TEXT NOT NULL DEFAULT '',
  payment_bank_name TEXT NOT NULL DEFAULT '',
  payment_note TEXT NOT NULL DEFAULT '',
  admin_note TEXT,
  handled_by INTEGER,
  handled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(handled_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_manual_wallet_requests_user ON manual_wallet_requests(user_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_manual_wallet_requests_status ON manual_wallet_requests(status,id DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender_user_id INTEGER,
  sender_role TEXT NOT NULL CHECK(sender_role IN ('user','admin')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id,id ASC);

CREATE TABLE IF NOT EXISTS tournament_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_type TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  entry_cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tournament_type,user_id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_tournament_entries_type ON tournament_entries(tournament_type,id);

CREATE TABLE IF NOT EXISTS tournament_rooms (
  tournament_type TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL DEFAULT 30,
  registered_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'registration',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tournament_events (
  id TEXT PRIMARY KEY,
  tournament_type TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  registration_opens_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  registered_count INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 30,
  prize_pool INTEGER NOT NULL DEFAULT 0,
  min_players INTEGER NOT NULL DEFAULT 5,
  stage TEXT NOT NULL DEFAULT 'registration',
  stages_json TEXT NOT NULL DEFAULT '[]',
  stage_round INTEGER NOT NULL DEFAULT 1,
  stage_rounds INTEGER NOT NULL DEFAULT 1,
  current_round_id TEXT,
  started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(tournament_type,scheduled_at)
);
CREATE INDEX IF NOT EXISTS idx_tournament_events_schedule ON tournament_events(tournament_type,scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tournament_events_status ON tournament_events(status,scheduled_at);

CREATE TABLE IF NOT EXISTS tournament_event_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  entry_cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  total_points INTEGER NOT NULL DEFAULT 0,
  line_wins INTEGER NOT NULL DEFAULT 0,
  full_wins INTEGER NOT NULL DEFAULT 0,
  rounds_played INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(event_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_tournament_event_entries_event
  ON tournament_event_entries(event_id,status,total_points DESC);

CREATE TABLE IF NOT EXISTS tournament_rounds (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'playing',
  called_numbers_json TEXT NOT NULL DEFAULT '[]',
  line_winner_ids_json TEXT NOT NULL DEFAULT '[]',
  full_winner_ids_json TEXT NOT NULL DEFAULT '[]',
  next_draw_at INTEGER,
  started_at INTEGER NOT NULL,
  finished_at TEXT,
  UNIQUE(event_id,stage,round_number)
);
CREATE INDEX IF NOT EXISTS idx_tournament_rounds_event ON tournament_rounds(event_id,started_at);

CREATE TABLE IF NOT EXISTS tournament_round_players (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  matched_count INTEGER NOT NULL DEFAULT 0,
  line_hit INTEGER NOT NULL DEFAULT 0,
  full_hit INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  scored_at TEXT,
  UNIQUE(round_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_tournament_round_players_round ON tournament_round_players(round_id,user_id);

CREATE TABLE IF NOT EXISTS tournament_prize_payouts (
  event_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id,user_id),
  UNIQUE(event_id,rank)
);
