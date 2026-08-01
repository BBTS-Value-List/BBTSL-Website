PRAGMA foreign_keys = ON;

ALTER TABLE audit_logs ADD COLUMN revert_expires_at TEXT;
ALTER TABLE audit_logs ADD COLUMN revert_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE audit_logs ADD COLUMN snapshots_disposed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_revert_expiry
  ON audit_logs (revert_expires_at, revert_status, id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reauth_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('user', 'system')),
  revoked_at TEXT,
  revoke_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON sessions (user_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry
  ON sessions (expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS media_quarantine (
  id TEXT PRIMARY KEY,
  base_key TEXT NOT NULL,
  audit_log_id INTEGER,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending',
    'copying',
    'quarantined',
    'restoring',
    'restored',
    'purging',
    'purged',
    'unavailable',
    'failed'
  )),
  descriptor_json TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  restored_at TEXT,
  purged_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_quarantine_active_base
  ON media_quarantine (base_key)
  WHERE status IN ('pending', 'copying', 'quarantined', 'restoring', 'purging');
CREATE INDEX IF NOT EXISTS idx_media_quarantine_purge
  ON media_quarantine (purge_after, status, id);
CREATE INDEX IF NOT EXISTS idx_media_quarantine_audit
  ON media_quarantine (audit_log_id, status);

CREATE TABLE IF NOT EXISTS media_quarantine_objects (
  quarantine_id TEXT NOT NULL,
  live_key TEXT NOT NULL,
  quarantine_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  content_type TEXT,
  etag TEXT,
  copy_status TEXT NOT NULL CHECK (copy_status IN (
    'pending',
    'copied',
    'restored',
    'purged',
    'missing',
    'failed'
  )),
  copied_at TEXT,
  restored_at TEXT,
  purged_at TEXT,
  last_error TEXT,
  PRIMARY KEY (quarantine_id, live_key),
  UNIQUE (quarantine_key),
  FOREIGN KEY (quarantine_id) REFERENCES media_quarantine(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_quarantine_objects_status
  ON media_quarantine_objects (copy_status, quarantine_id);

CREATE TABLE IF NOT EXISTS audit_media_refs (
  audit_log_id INTEGER NOT NULL,
  base_key TEXT NOT NULL,
  PRIMARY KEY (audit_log_id, base_key),
  FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_media_refs_base
  ON audit_media_refs (base_key, audit_log_id);

CREATE TABLE IF NOT EXISTS public_media_registry (
  media_key TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS security_maintenance_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
