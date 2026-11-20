/**
 * Live: AutoSNAP download fingerprint vs stored Supabase PDF for same Activity ID.
 */
import { Pool } from "pg";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { decrypt } = require("../backend/dist/security.js");
const {
  fetchOfficialPdf,
  pdfContentSha256,
  pdfEvidenceFingerprint,
  inspectPdfProvenance,
} = require("../backend/dist/aspi-evidence.js");

const activityId = process.argv[2] || "3597e432-66b3-4677-8d95-a243b949810c";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const stored = (
  await pool.query(
    `SELECT run_id, pdf_data, content_sha256, byte_size FROM autosnap_evidence_pdfs WHERE activity_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [activityId],
  )
).rows[0];
const user = (
  await pool.query(`SELECT data FROM autosnap_records WHERE kind='snap_user' ORDER BY updated_at DESC LIMIT 1`)
).rows[0];
await pool.end();

const chrome = [
  process.env.AUTOSNAP_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean).find(existsSync);
const context = await chromium.launchPersistentContext(
  join(process.cwd(), ".autosnap-browser-profile", "pdf-fingerprint-verify"),
  { executablePath: chrome, headless: true, acceptDownloads: true, viewport: { width: 1440, height: 900 } },
);
const page = context.pages()[0] || (await context.newPage());
const email = String(user.data.email || "");
const password = user.data.password ? decrypt(String(user.data.password)) : "";
await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
if (page.url().includes("sign-in") || (await page.locator('input[type="password"]').count())) {
  await page.locator('input[type="email"],input[name*="email" i]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => undefined),
    page.locator('form button[type="submit"],form input[type="submit"]').first().click(),
  ]);
}

const url = `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`;
const live = await fetchOfficialPdf(page, url, Date.now() + 90000, "navigation");
await context.close();

const storedPdf = stored ? Buffer.from(stored.pdf_data) : null;
const report = {
  activityId,
  live: {
    bytes: live.length,
    rawSha: pdfContentSha256(live),
    fingerprint: pdfEvidenceFingerprint(live),
    producer: inspectPdfProvenance(live).producer,
  },
  stored: storedPdf
    ? {
        run_id: stored.run_id,
        bytes: storedPdf.length,
        rawSha: pdfContentSha256(storedPdf),
        fingerprint: pdfEvidenceFingerprint(storedPdf),
        producer: inspectPdfProvenance(storedPdf).producer,
        roundTripOk: stored.content_sha256 === pdfContentSha256(storedPdf),
      }
    : null,
  fingerprintMatch: storedPdf ? pdfEvidenceFingerprint(live) === pdfEvidenceFingerprint(storedPdf) : null,
  rawShaMatch: storedPdf ? pdfContentSha256(live) === pdfContentSha256(storedPdf) : null,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.fingerprintMatch ? 0 : 2);
