CREATE TABLE IF NOT EXISTS autosnap_evidence_pdfs (
  run_id TEXT NOT NULL REFERENCES autosnap_runs(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  service TEXT NOT NULL,
  pdf_data BYTEA NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 15728640),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, activity_id)
);

CREATE INDEX IF NOT EXISTS autosnap_evidence_pdfs_created_idx
  ON autosnap_evidence_pdfs (created_at);

ALTER TABLE autosnap_evidence_pdfs ENABLE ROW LEVEL SECURITY;
