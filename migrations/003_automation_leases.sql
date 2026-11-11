SET search_path TO autosnap, public;
CREATE TABLE IF NOT EXISTS autosnap_automation_leases (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
