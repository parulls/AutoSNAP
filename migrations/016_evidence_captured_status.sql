-- Nest/local mirror: allow CAPTURED between UNVERIFIED and VERIFIED.
-- VERIFIED reserved for visual match vs user Firefox PDF — never auto-assigned on capture.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'autosnap_evidence_pdfs_verification_status_check'
  ) THEN
    ALTER TABLE autosnap_evidence_pdfs
      DROP CONSTRAINT autosnap_evidence_pdfs_verification_status_check;
  END IF;

  ALTER TABLE autosnap_evidence_pdfs
    ADD CONSTRAINT autosnap_evidence_pdfs_verification_status_check
    CHECK (verification_status IN ('VERIFIED', 'CAPTURED', 'UNVERIFIED'));
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_object THEN
    BEGIN
      ALTER TABLE autosnap_evidence_pdfs
        ADD CONSTRAINT autosnap_evidence_pdfs_verification_status_check
        CHECK (verification_status IN ('VERIFIED', 'CAPTURED', 'UNVERIFIED'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END $$;

UPDATE autosnap_evidence_pdfs
SET verification_status = 'CAPTURED'
WHERE verification_status = 'VERIFIED';
