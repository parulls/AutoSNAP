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
try {
  const cols = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'autosnap'
      AND table_name IN ('autosnap_evidence_pdfs', 'autosnap_automation_leases')
    ORDER BY table_name, ordinal_position
  `);
  console.log("columns", JSON.stringify(cols.rows, null, 2));

  const nest = await pool
    .query(`SELECT name FROM autosnap_migrations ORDER BY name`)
    .catch((e) => ({ rows: [{ error: e.message }] }));
  console.log("autosnap_migrations", JSON.stringify(nest.rows, null, 2));

  const sm = await pool
    .query(`SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version`)
    .catch((e) => ({ rows: [{ error: e.message }] }));
  console.log("supabase_migrations_tail", JSON.stringify(sm.rows.slice(-20), null, 2));

  // Probe the exact failing statements safely (rollback).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sql of [
      "SELECT content_sha256 FROM autosnap_evidence_pdfs LIMIT 0",
      "SELECT heartbeat_at FROM autosnap_automation_leases LIMIT 0",
      "INSERT INTO autosnap_evidence_pdfs(run_id,activity_id,service,pdf_data,byte_size,content_sha256,created_at) VALUES('probe','probe','probe','\\\\x25504446',1,'abc',NOW()::text)",
    ]) {
      try {
        await client.query(sql);
        console.log("OK", sql.slice(0, 80));
      } catch (e) {
        console.log("FAIL", e.code, e.message, "|", sql.slice(0, 80));
      }
    }
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
