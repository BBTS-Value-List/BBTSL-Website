PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bot_request_nonces (
  client_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  actor_discord_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (client_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_bot_request_nonces_expiry
  ON bot_request_nonces (expires_at, client_id, nonce);

CREATE TABLE IF NOT EXISTS bot_reauth_challenges (
  id TEXT PRIMARY KEY,
  actor_discord_user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'consumed', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bot_reauth_challenges_actor
  ON bot_reauth_challenges (actor_discord_user_id, client_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_bot_reauth_challenges_expiry
  ON bot_reauth_challenges (expires_at, status, id);

CREATE TABLE IF NOT EXISTS audit_sources (
  audit_log_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('discord-bot')),
  source_request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_sources_source
  ON audit_sources (source, created_at, audit_log_id);
