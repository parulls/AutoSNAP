CREATE TABLE IF NOT EXISTS autosnap_password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES autosnap_users(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS autosnap_password_resets_user ON autosnap_password_resets(user_id);
CREATE INDEX IF NOT EXISTS autosnap_password_resets_expiry ON autosnap_password_resets(expires_at);
ALTER TABLE autosnap_password_resets ENABLE ROW LEVEL SECURITY;
