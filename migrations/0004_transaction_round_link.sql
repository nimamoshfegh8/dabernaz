-- Add a structured round reference to new room-related wallet transactions.
-- Existing history is preserved; legacy rows remain NULL because their round cannot
-- always be proven from the available historical records.
ALTER TABLE transactions
  ADD COLUMN round_id TEXT REFERENCES room_rounds(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_transactions_round_id
  ON transactions(round_id, id);

INSERT OR IGNORE INTO schema_migrations(version, name)
VALUES (4, 'transaction_round_link');
