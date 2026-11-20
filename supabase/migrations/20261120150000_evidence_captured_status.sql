-- CAPTURED = official ASPI html2pdf/jsPDF blob stored (integrity + origin).
-- VERIFIED = layout/visual match against a user-supplied Firefox reference (never auto).
-- UNVERIFIED = Chromium print / unknown / legacy — must re-download.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'autosnap_evidence_pdfs_verification_status_check'
  ) THEN
    ALTER TABLE autosnap.autosnap_evidence_pdfs
      DROP CONSTRAINT autosnap_evidence_pdfs_verification_status_check;
  END IF;

  ALTER TABLE autosnap.autosnap_evidence_pdfs
    ADD CONSTRAINT autosnap_evidence_pdfs_verification_status_check
    CHECK (verification_status IN ('VERIFIED', 'CAPTURED', 'UNVERIFIED'));
END $$;

-- Downgrade prior auto-VERIFIED rows that were never visually compared to a Firefox reference.
UPDATE autosnap.autosnap_evidence_pdfs
SET verification_status = 'CAPTURED'
WHERE verification_status = 'VERIFIED';
