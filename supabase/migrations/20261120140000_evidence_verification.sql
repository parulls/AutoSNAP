-- Evidence authenticity layers:
-- CAPTURED = ASPI Download (html2pdf/jsPDF) bytes (integrity + origin).
-- VERIFIED = visual/layout match vs user Firefox reference (never auto on capture).
-- UNVERIFIED = Chromium print / legacy / unknown.
ALTER TABLE autosnap.autosnap_evidence_pdfs
  ADD COLUMN IF NOT EXISTS content_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS pdf_producer TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS downloaded_at TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'autosnap_evidence_pdfs_verification_status_check'
  ) THEN
    ALTER TABLE autosnap.autosnap_evidence_pdfs
      ADD CONSTRAINT autosnap_evidence_pdfs_verification_status_check
      CHECK (verification_status IN ('VERIFIED', 'CAPTURED', 'UNVERIFIED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS autosnap_evidence_pdfs_verification_idx
  ON autosnap.autosnap_evidence_pdfs (verification_status);

CREATE INDEX IF NOT EXISTS autosnap_evidence_pdfs_fingerprint_idx
  ON autosnap.autosnap_evidence_pdfs (content_fingerprint);

-- Backup before overwrite / re-download. Never delete without trail.
CREATE TABLE IF NOT EXISTS autosnap.autosnap_evidence_pdfs_backup (
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

CREATE INDEX IF NOT EXISTS autosnap_evidence_pdfs_backup_run_idx
  ON autosnap.autosnap_evidence_pdfs_backup (run_id, activity_id);

ALTER TABLE autosnap.autosnap_evidence_pdfs_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE autosnap.autosnap_evidence_pdfs_backup FROM anon, authenticated;
