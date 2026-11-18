SET search_path TO autosnap, public;

-- Backup unused structures before dropping them.
-- History, official PDF evidence, master data, sessions, and user privileges are kept.
CREATE SCHEMA IF NOT EXISTS autosnap_archive;

DO $$
BEGIN
  IF to_regclass('autosnap_archive.autosnap_captchas') IS NULL AND to_regclass('autosnap.autosnap_captchas') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE autosnap_archive.autosnap_captchas AS TABLE autosnap.autosnap_captchas';
  END IF;
  IF to_regclass('autosnap.autosnap_captchas') IS NOT NULL THEN
    DROP TABLE autosnap.autosnap_captchas;
  END IF;
  IF to_regclass('autosnap_archive.autosnap_evidence_screenshots') IS NULL AND to_regclass('autosnap.autosnap_evidence_screenshots') IS NOT NULL THEN
    EXECUTE 'CREATE TABLE autosnap_archive.autosnap_evidence_screenshots AS TABLE autosnap.autosnap_evidence_screenshots';
  END IF;
  IF to_regclass('autosnap.autosnap_evidence_screenshots') IS NOT NULL THEN
    DROP TABLE autosnap.autosnap_evidence_screenshots;
  END IF;
END $$;

REVOKE ALL ON SCHEMA autosnap_archive FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA autosnap_archive FROM PUBLIC, anon, authenticated;

ALTER TABLE autosnap_automation_leases ADD COLUMN IF NOT EXISTS heartbeat_at TEXT;
UPDATE autosnap_automation_leases SET heartbeat_at = expires_at WHERE heartbeat_at IS NULL;

-- Rename the operator role without touching privileges or sessions.
UPDATE autosnap_users SET role = 'petugas' WHERE role = 'tester';
ALTER TABLE autosnap_users ALTER COLUMN role SET DEFAULT 'petugas';
