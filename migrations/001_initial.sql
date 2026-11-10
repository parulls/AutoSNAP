CREATE SCHEMA IF NOT EXISTS autosnap;
SET search_path TO autosnap, public;

CREATE TABLE IF NOT EXISTS autosnap_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  username TEXT,
  role TEXT NOT NULL DEFAULT 'tester',
  active BOOLEAN NOT NULL DEFAULT TRUE
);
UPDATE autosnap_users SET username=LOWER(email) WHERE username IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS autosnap_users_username ON autosnap_users (LOWER(username));
CREATE TABLE IF NOT EXISTS autosnap_captchas (id TEXT PRIMARY KEY,answer_hash TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS autosnap_sessions (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES autosnap_users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS autosnap_records (id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,parent_id TEXT,partner_id TEXT UNIQUE,data JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS autosnap_records_kind ON autosnap_records(kind);
CREATE INDEX IF NOT EXISTS autosnap_records_parent ON autosnap_records(parent_id);
CREATE TABLE IF NOT EXISTS autosnap_runs (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,user_id TEXT,service_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,scenario_id TEXT,mode TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER,response_code TEXT,expected_code TEXT,duration_ms INTEGER,request_json JSONB NOT NULL,response_json JSONB NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS autosnap_runs_created ON autosnap_runs(created_at DESC);
CREATE TABLE IF NOT EXISTS autosnap_external_ids (environment_id TEXT NOT NULL,external_id TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(environment_id,external_id,day));
