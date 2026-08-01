CREATE TABLE IF NOT EXISTS request_rate_limits_v2 (
  bucket TEXT NOT NULL,
  client_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, client_key)
);

CREATE INDEX IF NOT EXISTS idx_request_rate_limits_v2_expires_at
  ON request_rate_limits_v2 (expires_at);

CREATE TABLE IF NOT EXISTS site_state_mutation_locks (
  lock_name TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
