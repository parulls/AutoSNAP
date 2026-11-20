/**
 * Apply evidence verification migration + mark Chromium-print PDFs as UNVERIFIED.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { createRequire } from "node:module";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { inspectPdfProvenance, pdfEvidenceFingerprint, validateOfficialPdf } =
  require("../backend/dist/aspi-evidence.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "20261120140000_evidence_verification.sql"),
  "utf8",
);
await pool.query(sql);
console.log("migration_applied");

const rows = (
  await pool.query(`SELECT run_id, activity_id, pdf_data, content_sha256 FROM autosnap_evidence_pdfs`)
).rows;

let verified = 0;
let unverified = 0;
let corrupt = 0;
for (const row of rows) {
  try {
    const pdf = validateOfficialPdf(Buffer.from(row.pdf_data));
    const prov = inspectPdfProvenance(pdf);
    const fingerprint = pdfEvidenceFingerprint(pdf);
    // Capture proves origin only — never auto-VERIFIED without Firefox visual compare.
    const status = prov.fromAspHtml2Pdf && !prov.fromChromiumPrint ? "CAPTURED" : "UNVERIFIED";
    await pool.query(
      `UPDATE autosnap_evidence_pdfs
       SET verification_status=$1, content_fingerprint=$2, pdf_producer=$3
       WHERE run_id=$4 AND activity_id=$5`,
      [status, fingerprint, prov.producer || null, row.run_id, row.activity_id],
    );
    if (status === "CAPTURED") verified++;
    else unverified++;
  } catch {
    await pool.query(
      `UPDATE autosnap_evidence_pdfs SET verification_status='UNVERIFIED' WHERE run_id=$1 AND activity_id=$2`,
      [row.run_id, row.activity_id],
    );
    corrupt++;
    unverified++;
  }
}

const counts = (
  await pool.query(
    `SELECT verification_status, COUNT(*)::int AS n FROM autosnap_evidence_pdfs GROUP BY 1 ORDER BY 1`,
  )
).rows;
console.log(JSON.stringify({ scanned: rows.length, verified, unverified, corrupt, counts }, null, 2));
await pool.end();
