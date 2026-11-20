ALTER TABLE autosnap_evidence_pdfs ADD COLUMN IF NOT EXISTS content_sha256 TEXT;
CREATE INDEX IF NOT EXISTS autosnap_evidence_pdfs_sha256_idx ON autosnap_evidence_pdfs (content_sha256);
