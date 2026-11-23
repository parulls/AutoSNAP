/**
 * Audit stored Create VA evidence: provenance, integrity, activity linkage.
 * Does not claim Firefox visual identity.
 */
import process from "node:process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Pool } from "pg";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const {
  inspectPdfProvenance,
  pdfContentSha256,
  pdfEvidenceFingerprint,
  validateAspiDownloadPdf,
} = require("../backend/dist/aspi-evidence.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});

const rows = (
  await pool.query(
    `SELECT e.run_id, e.activity_id, e.service, e.byte_size, e.content_sha256, e.content_fingerprint,
            e.verification_status, e.pdf_producer, e.source_url, e.pdf_data, r.status, r.created_at
     FROM autosnap_evidence_pdfs e
     JOIN autosnap_runs r ON r.id = e.run_id
     WHERE e.service ILIKE '%virtual%account%' OR e.service ILIKE '%create%va%' OR e.service ILIKE '%VA%'
        OR e.source_url ILIKE '%virtual%'
     ORDER BY r.created_at DESC NULLS LAST
     LIMIT 20`,
  )
).rows;

const report = [];
for (const row of rows) {
  const buf = Buffer.from(row.pdf_data);
  const liveSha = createHash("sha256").update(buf).digest("hex");
  let provenance = null;
  let ok = false;
  let error = null;
  try {
    validateAspiDownloadPdf(buf);
    provenance = inspectPdfProvenance(buf);
    ok = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    try {
      provenance = inspectPdfProvenance(buf);
    } catch {
      /* ignore */
    }
  }
  report.push({
    runId: row.run_id,
    activityId: row.activity_id,
    service: row.service,
    runStatus: row.status,
    verification_status: row.verification_status,
    byte_size: row.byte_size,
    stored_sha256: row.content_sha256,
    live_sha256: liveSha,
    sha_matches_store: row.content_sha256 === liveSha,
    size_matches: row.byte_size === buf.length,
    fingerprint: pdfEvidenceFingerprint(buf),
    stored_fingerprint: row.content_fingerprint,
    producer: provenance?.producer ?? row.pdf_producer,
    fromAspHtml2Pdf: provenance?.fromAspHtml2Pdf ?? false,
    fromChromiumPrint: provenance?.fromChromiumPrint ?? false,
    source_url: row.source_url,
    validate_ok: ok,
    validate_error: error,
  });
}

console.log(
  JSON.stringify(
    {
      scanned: report.length,
      note: "SHA equality checks storage integrity, not Firefox visual match. ASPI html2pdf regenerates CreationDate/ID per download.",
      rows: report,
    },
    null,
    2,
  ),
);
await pool.end();
