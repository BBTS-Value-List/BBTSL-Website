CREATE TABLE IF NOT EXISTS r2_usage_counters (
  period TEXT PRIMARY KEY,
  class_a_count INTEGER NOT NULL DEFAULT 0 CHECK (class_a_count >= 0),
  class_b_count INTEGER NOT NULL DEFAULT 0 CHECK (class_b_count >= 0),
  updated_at TEXT NOT NULL
);
