ALTER TABLE autosnap_evidence_pdfs
  ADD COLUMN IF NOT EXISTS content_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS pdf_producer TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS downloaded_at TEXT;

CREATE TABLE IF NOT EXISTS autosnap_evidence_pdfs_backup (
  backup_id BIGSERIAL PRIMARY KEY,
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL,
  run_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  service TEXT NOT NULL,
  pdf_data BYTEA NOT NULL,
  byte_size INTEGER NOT NULL,
  content_sha256 TEXT,
  content_fingerprint TEXT,
  verification_status TEXT,
  pdf_producer TEXT,
  source_url TEXT,
  downloaded_at TEXT,
  original_created_at TEXT
);
