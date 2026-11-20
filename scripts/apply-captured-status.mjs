import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import process from "node:process";

process.loadEnvFile(".env.local");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261120150000_evidence_captured_status.sql"),
  "utf8",
);
await pool.query(sql);
const counts = (
  await pool.query(
    `SELECT verification_status, COUNT(*)::int AS n FROM autosnap_evidence_pdfs GROUP BY 1 ORDER BY 1`,
  )
).rows;
console.log(JSON.stringify({ migration: "20261120150000_evidence_captured_status", counts }, null, 2));
await pool.end();
