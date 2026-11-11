SET search_path TO autosnap, public;
CREATE TABLE IF NOT EXISTS autosnap_automation_leases (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
ALTER TABLE autosnap_automation_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE autosnap_automation_leases FROM PUBLIC, anon, authenticated;
