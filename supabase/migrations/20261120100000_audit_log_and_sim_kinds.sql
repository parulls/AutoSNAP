CREATE TABLE IF NOT EXISTS autosnap_audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES autosnap_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS autosnap_audit_log_created ON autosnap_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS autosnap_audit_log_actor ON autosnap_audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS autosnap_runs_mode_created ON autosnap_runs(mode, created_at DESC);
