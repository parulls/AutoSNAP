-- Speed up Admin cross-user History filters without changing ownership semantics.
-- operator_id + created_at already exists from run ownership migration.

CREATE INDEX IF NOT EXISTS autosnap_runs_status_created_idx
  ON autosnap.autosnap_runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS autosnap_runs_service_created_idx
  ON autosnap.autosnap_runs (service_id, created_at DESC);

CREATE INDEX IF NOT EXISTS autosnap_runs_endpoint_created_idx
  ON autosnap.autosnap_runs (endpoint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS autosnap_runs_operator_snapshot_role_idx
  ON autosnap.autosnap_runs ((request_json->'operator'->>'role'));
