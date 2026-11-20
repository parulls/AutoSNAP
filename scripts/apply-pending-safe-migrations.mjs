import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

process.loadEnvFile(".env.local");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  allowExitOnIdle: true,
  options: "-c search_path=autosnap,public",
});

const pending = [
  {
    version: "20261120100000",
    name: "audit_log_and_sim_kinds",
    file: "supabase/migrations/20261120100000_audit_log_and_sim_kinds.sql",
  },
  {
    version: "20261120110000",
    name: "evidence_pdf_sha256",
    file: "supabase/migrations/20261120110000_evidence_pdf_sha256.sql",
  },
];

try {
  for (const item of pending) {
    const exists = await pool.query(
      `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`,
      [item.version],
    ).catch(() => ({ rowCount: 0 }));
    if (exists.rowCount) {
      console.log("skip", item.version, item.name);
      continue;
    }
    const sql = readFileSync(join(process.cwd(), item.file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(
        `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT (version) DO NOTHING`,
        [item.version, item.name],
      );
      await pool.query("COMMIT");
      console.log("applied", item.version, item.name);
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
  }
  const check = await pool.query(`
    SELECT
      to_regclass('autosnap.autosnap_audit_log') AS audit_log,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='autosnap' AND table_name='autosnap_evidence_pdfs' AND column_name='content_sha256'
      ) AS has_content_sha256
  `);
  console.log(JSON.stringify(check.rows[0], null, 2));
} finally {
  await pool.end();
}
