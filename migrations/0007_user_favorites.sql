PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_favorites (
  discord_user_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (discord_user_id, card_id)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user_updated
  ON user_favorites (discord_user_id, updated_at DESC, card_id ASC);

CREATE TABLE IF NOT EXISTS favorite_rate_cooldowns (
  discord_user_id TEXT PRIMARY KEY,
  cooldown_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_favorite_rate_cooldowns_expiry
  ON favorite_rate_cooldowns (cooldown_until);
