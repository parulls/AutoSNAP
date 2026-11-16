ALTER TABLE autosnap_users ADD COLUMN IF NOT EXISTS privileges JSONB NOT NULL DEFAULT '["dashboard","dev_site","client_simulator"]'::jsonb;
