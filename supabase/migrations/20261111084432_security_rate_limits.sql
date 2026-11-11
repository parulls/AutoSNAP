SET search_path TO autosnap, public;
CREATE TABLE IF NOT EXISTS autosnap_rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts>0),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS autosnap_rate_limits_expiry ON autosnap_rate_limits(expires_at);
-- API access uses a server-side database connection, never browser Supabase keys.
ALTER TABLE autosnap_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE autosnap_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE autosnap_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE autosnap_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE autosnap_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE autosnap_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE autosnap_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA autosnap FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA autosnap FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA autosnap REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
