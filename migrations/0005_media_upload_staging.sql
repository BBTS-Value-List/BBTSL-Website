PRAGMA foreign_keys = ON;

ALTER TABLE audit_logs ADD COLUMN commit_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_commit_id
  ON audit_logs (commit_id)
  WHERE commit_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS media_upload_staging (
  id TEXT PRIMARY KEY,
  actor_user_id INTEGER NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('card-image', 'detail', 'slash', 'slash-audio', 'finisher')),
  idempotency_key TEXT NOT NULL,
  base_key TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  objects_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'committed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  commit_id TEXT,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (actor_user_id, variant, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_media_upload_staging_expiry
  ON media_upload_staging (expires_at, status, id);

CREATE INDEX IF NOT EXISTS idx_media_upload_staging_actor_status
  ON media_upload_staging (actor_user_id, status, expires_at);
