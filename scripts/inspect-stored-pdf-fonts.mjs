import { Pool } from "pg";
import process from "node:process";
process.loadEnvFile(".env.local");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const rows = (
  await pool.query(`
    SELECT run_id, activity_id, service, byte_size, verification_status, pdf_producer, pdf_data, created_at
    FROM autosnap_evidence_pdfs
    ORDER BY created_at DESC
    LIMIT 20
  `)
).rows;
for (const row of rows) {
  const buf = Buffer.from(row.pdf_data);
  const latin = buf.toString("latin1");
  const producer = (latin.match(/\/Producer\s*\(([^)]*)\)/) || [])[1] || "";
  const creator = (latin.match(/\/Creator\s*\(([^)]*)\)/) || [])[1] || "";
  const fonts = [...new Set([...latin.matchAll(/\/BaseFont\s*\/([^\s\/]+)/g)].map((m) => m[1]))].slice(0, 12);
  const hasSkia = /Skia|Chrome|Chromium/i.test(producer + creator);
  const hasJsPdf = /jsPDF/i.test(producer + creator);
  console.log(
    JSON.stringify({
      run: row.run_id,
      activity: row.activity_id.slice(0, 8),
      service: row.service,
      status: row.verification_status,
      bytes: buf.length,
      producer,
      creator,
      fonts,
      kind: hasJsPdf ? "ASPI-html2pdf" : hasSkia ? "CHROMIUM-PRINT" : "OTHER",
    }),
  );
}
await pool.end();
