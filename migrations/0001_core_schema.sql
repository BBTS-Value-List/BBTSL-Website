CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT NOT NULL UNIQUE,
  username TEXT,
  global_name TEXT,
  avatar_hash TEXT,
  role TEXT NOT NULL DEFAULT 'Viewer',
  role_sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_role TEXT,
  action_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_public_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  diff_json TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role_sort
  ON users (role_sort DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_public_id
  ON audit_logs (entity_public_id);

UPDATE users
SET role_sort = CASE role
  WHEN 'Viewer' THEN 0
  WHEN 'Contributor' THEN 1
  WHEN 'Editor' THEN 2
  WHEN 'Maintainer' THEN 3
  WHEN 'Administrator' THEN 4
  WHEN 'Developer' THEN 5
  WHEN 'Owner' THEN 6
  ELSE -1
END
WHERE role_sort <> CASE role
  WHEN 'Viewer' THEN 0
  WHEN 'Contributor' THEN 1
  WHEN 'Editor' THEN 2
  WHEN 'Maintainer' THEN 3
  WHEN 'Administrator' THEN 4
  WHEN 'Developer' THEN 5
  WHEN 'Owner' THEN 6
  ELSE -1
END;
