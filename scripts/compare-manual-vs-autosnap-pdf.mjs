/**
 * Side-by-side: official Download click vs AutoSNAP capture for ONE activityId.
 * Extracts producer, fonts, approx text lines — proves whether AutoSNAP fabricates PDF.
 */
import { Pool } from "pg";
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { decrypt } = require("../backend/dist/security.js");
const { fetchOfficialPdf, pdfEvidenceFingerprint, inspectPdfProvenance } =
  require("../backend/dist/aspi-evidence.js");

const activityId = process.argv[2];
if (!activityId) {
  console.error("Usage: node scripts/compare-manual-vs-autosnap-pdf.mjs <activityId>");
  process.exit(1);
}
const outDir = join(process.cwd(), "scripts", ".pdf-compare");
mkdirSync(outDir, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const user = (
  await pool.query(`SELECT data FROM autosnap_records WHERE kind='snap_user' ORDER BY updated_at DESC LIMIT 1`)
).rows[0];
await pool.end();
const email = String(user.data.email || "");
const password = user.data.password ? decrypt(String(user.data.password)) : "";
const chrome = [
  process.env.AUTOSNAP_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean).find(existsSync);

function meta(buf, label) {
  const latin = buf.toString("latin1");
  const producer = (latin.match(/\/Producer\s*\(([^)]*)\)/) || [])[1] || "";
  const creator = (latin.match(/\/Creator\s*\(([^)]*)\)/) || [])[1] || "";
  const fonts = [...new Set([...latin.matchAll(/\/BaseFont\s*\/([^\s\/]+)/g)].map((m) => m[1]))];
  // Rough extract of visible strings (jsPDF often stores text as literals)
  const strings = [...latin.matchAll(/\(([^)\\]|\\.)*\)/g)]
    .map((m) => m[0].slice(1, -1))
    .filter((s) => s.length > 2 && /[A-Za-z0-9]/.test(s) && !/^D:/.test(s))
    .slice(0, 80);
  return {
    label,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    fingerprint: pdfEvidenceFingerprint(buf),
    producer,
    creator,
    fonts,
    provenance: inspectPdfProvenance(buf),
    sampleStrings: strings.slice(0, 25),
    stringCount: strings.length,
  };
}

const context = await chromium.launchPersistentContext(
  join(process.cwd(), ".autosnap-browser-profile", "pdf-compare-live"),
  { executablePath: chrome, headless: true, acceptDownloads: true, viewport: { width: 1440, height: 900 } },
);
const page = context.pages()[0] || (await context.newPage());
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
  await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
}

const url = `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`;

// A) Official Download link click (same as portal UI)
const search = page.locator('input[type="search"]').first();
if (await search.count()) {
  await search.fill(activityId);
  await new Promise((r) => setTimeout(r, 1000));
}
const link = page.locator(`a[href*="downloadreportactivity"][href*="activityId=${activityId}"]`).first();
let manualBuf;
if (await link.count()) {
  const dl = Promise.race([
    page.waitForEvent("download", { timeout: 120000 }),
    context.waitForEvent("page").then(async (p) => {
      await p.waitForLoadState("domcontentloaded").catch(() => undefined);
      return p.waitForEvent("download", { timeout: 120000 });
    }),
  ]);
  await link.click({ force: true });
  const download = await dl;
  const path = await download.path();
  manualBuf = path ? readFileSync(path) : Buffer.alloc(0);
} else {
  // Activity not on list — open Download URL directly (same href as the button)
  const report = await context.newPage();
  const pending = report.waitForEvent("download", { timeout: 120000 });
  await report.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
    referer: "https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian",
  });
  const download = await pending;
  const path = await download.path();
  manualBuf = path ? readFileSync(path) : Buffer.alloc(0);
  await report.close().catch(() => undefined);
}
writeFileSync(join(outDir, `manual-${activityId}.pdf`), manualBuf);

// B) AutoSNAP navigation capture
const autoBuf = await fetchOfficialPdf(page, url, Date.now() + 90000, "navigation");
writeFileSync(join(outDir, `autosnap-${activityId}.pdf`), autoBuf);

const a = meta(manualBuf, "manual-Download-button");
const b = meta(autoBuf, "autosnap-capture");
const report = {
  activityId,
  downloadUrl: url,
  manual: a,
  autosnap: b,
  identicalBytes: a.sha256 === b.sha256,
  identicalFingerprint: a.fingerprint === b.fingerprint,
  sameFonts: JSON.stringify(a.fonts) === JSON.stringify(b.fonts),
  sameProducer: a.producer === b.producer,
  conclusion:
    a.provenance.fromAspHtml2Pdf && b.provenance.fromAspHtml2Pdf
      ? "Both are ASPI Download blobs (jsPDF). AutoSNAP did not invent a Chromium/print PDF."
      : "MISMATCH: one side is not ASPI html2pdf — investigate immediately.",
};
console.log(JSON.stringify(report, null, 2));
await context.close();
process.exit(a.fingerprint === b.fingerprint && a.provenance.fromAspHtml2Pdf && b.provenance.fromAspHtml2Pdf ? 0 : 2);
