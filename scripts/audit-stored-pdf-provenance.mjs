/**
 * Audit stored evidence PDFs: jsPDF (ASPI Download) vs Chromium print vs unknown.
 */
import { Pool } from "pg";
import { createRequire } from "node:module";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { inspectPdfProvenance, pdfContentSha256, pdfEvidenceFingerprint, validateOfficialPdf } =
  require("../backend/dist/aspi-evidence.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const rows = (
  await pool.query(`
    SELECT run_id, activity_id, service, byte_size, content_sha256, created_at, pdf_data
    FROM autosnap_evidence_pdfs
    ORDER BY created_at DESC
    LIMIT 40
  `)
).rows;
await pool.end();

const summary = { total: rows.length, aspiHtml2Pdf: 0, chromiumPrint: 0, unknown: 0, corrupt: 0, samples: [] };
for (const row of rows) {
  try {
    const pdf = validateOfficialPdf(Buffer.from(row.pdf_data));
    const prov = inspectPdfProvenance(pdf);
    const liveSha = pdfContentSha256(pdf);
    const item = {
      run_id: row.run_id,
      activity_id: row.activity_id,
      service: row.service,
      bytes: pdf.length,
      storedSha: row.content_sha256,
      liveSha,
      shaMatch: !row.content_sha256 || row.content_sha256 === liveSha,
      fingerprint: pdfEvidenceFingerprint(pdf),
      producer: prov.producer,
      authenticity: prov.fromAspHtml2Pdf
        ? "aspi-html2pdf-download"
        : prov.fromChromiumPrint
          ? "chromium-print"
          : "unverified",
    };
    if (prov.fromAspHtml2Pdf) summary.aspiHtml2Pdf++;
    else if (prov.fromChromiumPrint) summary.chromiumPrint++;
    else summary.unknown++;
    if (summary.samples.length < 12) summary.samples.push(item);
  } catch {
    summary.corrupt++;
  }
}
console.log(JSON.stringify(summary, null, 2));
