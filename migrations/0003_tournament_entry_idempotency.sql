-- Stable idempotency for recurring tournament registrations.
-- A retry after the scheduled event starts must return the original entry,
-- never silently charge the account for the next recurring event.
CREATE TABLE IF NOT EXISTS tournament_entry_idempotency (
  user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  event_id TEXT NOT NULL,
  entry_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, idempotency_key),
  UNIQUE (event_id, user_id),
  UNIQUE (entry_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES tournament_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (entry_id) REFERENCES tournament_event_entries(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_tournament_entry_idempotency_created
  ON tournament_entry_idempotency(created_at);

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (3, 'tournament_entry_idempotency');
