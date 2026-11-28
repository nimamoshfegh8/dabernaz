-- Durable idempotency claims for user-submitted manual wallet requests.
-- Additive and safe to re-run: legacy requests remain intact and unkeyed.
CREATE TABLE IF NOT EXISTS wallet_request_idempotency (
  user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_id INTEGER UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, idempotency_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (request_id) REFERENCES manual_wallet_requests(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_wallet_request_idempotency_created
  ON wallet_request_idempotency(created_at);

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (2, 'wallet_request_idempotency');
