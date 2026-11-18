-- Mirror of supabase/migrations/20261111013328_add_session_user_index.sql
-- For Nest/PGlite DBs that already applied 001 before the session index existed.
CREATE INDEX IF NOT EXISTS autosnap_sessions_user_id ON autosnap_sessions(user_id);
ALTER TABLE autosnap_users ALTER COLUMN username SET NOT NULL;
