SET search_path TO autosnap, public;
CREATE TABLE IF NOT EXISTS autosnap_rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts>0),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS autosnap_rate_limits_expiry ON autosnap_rate_limits(expires_at);
