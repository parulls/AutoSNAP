-- PGlite/test mirror of supabase/migrations/20261119160000_history_operator_indexes.sql
CREATE INDEX IF NOT EXISTS autosnap_runs_status_created_idx ON autosnap_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS autosnap_runs_service_created_idx ON autosnap_runs (service_id, created_at DESC);
CREATE INDEX IF NOT EXISTS autosnap_runs_endpoint_created_idx ON autosnap_runs (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS autosnap_runs_operator_snapshot_role_idx ON autosnap_runs ((request_json->'operator'->>'role'));
