import { Pool } from "pg";
import process from "node:process";

process.loadEnvFile(".env.local");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  allowExitOnIdle: true,
  options: "-c search_path=autosnap,public",
});

const sql = `
ALTER TABLE autosnap_evidence_pdfs ADD COLUMN IF NOT EXISTS content_sha256 TEXT;
CREATE INDEX IF NOT EXISTS autosnap_evidence_pdfs_sha256_idx ON autosnap_evidence_pdfs (content_sha256);
`;

try {
  await pool.query("BEGIN");
  await pool.query(sql);
  // Record in supabase_migrations if table exists (idempotent version marker).
  await pool
    .query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name)
       VALUES ('20261120110000', 'evidence_pdf_sha256')
       ON CONFLICT (version) DO NOTHING`,
    )
    .catch(() => undefined);
  await pool.query("COMMIT");
  const cols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='autosnap' AND table_name='autosnap_evidence_pdfs'
    ORDER BY ordinal_position
  `);
  console.log(JSON.stringify({ ok: true, columns: cols.rows.map((r) => r.column_name) }, null, 2));
} catch (e) {
  await pool.query("ROLLBACK").catch(() => undefined);
  console.error(e);
  process.exit(1);
} finally {
  await pool.end();
}
