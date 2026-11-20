import { Pool } from "pg";
import process from "node:process";
process.loadEnvFile(".env.local");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const verified = (
  await pool.query(
    `SELECT activity_id FROM autosnap_evidence_pdfs WHERE run_id='RUN-20261120-915C11EC' ORDER BY service`,
  )
).rows;
console.log("latest_run_activities", verified);

const unverified = (
  await pool.query(
    `SELECT activity_id, pdf_data FROM autosnap_evidence_pdfs WHERE verification_status='UNVERIFIED' ORDER BY created_at DESC LIMIT 3`,
  )
).rows;
for (const row of unverified) {
  const l = Buffer.from(row.pdf_data).toString("latin1");
  console.log(
    JSON.stringify({
      id: row.activity_id,
      producer: (l.match(/\/Producer\s*\(([^)]*)\)/) || [])[1],
      creator: (l.match(/\/Creator\s*\(([^)]*)\)/) || [])[1],
      fonts: [...new Set([...l.matchAll(/\/BaseFont\s*\/([^\s\/]+)/g)].map((m) => m[1]))].slice(0, 8),
    }),
  );
}
await pool.end();
