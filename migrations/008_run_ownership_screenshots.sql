ALTER TABLE autosnap_runs ADD COLUMN IF NOT EXISTS operator_id TEXT REFERENCES autosnap_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS autosnap_runs_operator_created ON autosnap_runs(operator_id,created_at DESC);

CREATE TABLE IF NOT EXISTS autosnap_evidence_screenshots (
  run_id TEXT NOT NULL REFERENCES autosnap_runs(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  file_name TEXT NOT NULL,
  image_data BYTEA NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id,evidence_id)
);
ALTER TABLE autosnap_evidence_screenshots ENABLE ROW LEVEL SECURITY;
