CREATE TABLE IF NOT EXISTS autosnap_test_progress (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES autosnap_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS autosnap_test_progress_user ON autosnap_test_progress(user_id,updated_at DESC);
ALTER TABLE autosnap_test_progress ENABLE ROW LEVEL SECURITY;
