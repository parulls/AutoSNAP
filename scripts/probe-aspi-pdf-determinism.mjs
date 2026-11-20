/**
 * Prove whether ASPI downloadreportactivity (html2pdf) is byte-stable across two navigations.
 * This is the same URL the Download button opens (target=_blank).
 */
import { Pool } from "pg";
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { decrypt } = require("../backend/dist/security.js");

const activityId = process.argv[2] || "3597e432-66b3-4677-8d95-a243b949810c";
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

const context = await chromium.launchPersistentContext(
  join(process.cwd(), ".autosnap-browser-profile", "pdf-determinism"),
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
}

const url = `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`;

async function one(label) {
  const report = await context.newPage();
  const pending = report.waitForEvent("download", { timeout: 120000 });
  await report.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
    referer: "https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian",
  });
  // Match ASPI page: wait for logos + html2pdf before/while download() runs
  await report.locator("#printPdf img").nth(1).waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined);
  await report.waitForFunction(() => typeof window.html2pdf === "function", null, { timeout: 30000 }).catch(() => undefined);
  const download = await pending;
  const path = await download.path();
  const buf = path ? readFileSync(path) : Buffer.alloc(0);
  const latin = buf.toString("latin1");
  const meta = {
    label,
    suggested: download.suggestedFilename(),
    url: download.url(),
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    creation: (latin.match(/\/CreationDate\s*\(([^)]*)\)/) || [])[1] || null,
    producer: (latin.match(/\/Producer\s*\(([^)]{0,80})\)/) || [])[1] || null,
  };
  writeFileSync(join(outDir, `${label}-${activityId}.pdf`), buf);
  await report.close().catch(() => undefined);
  return meta;
}

const first = await one("gen-a");
await new Promise((r) => setTimeout(r, 1000));
const second = await one("gen-b");

// Strip volatile PDF metadata and compare body-ish fingerprint
function stripMeta(buf) {
  let s = buf.toString("latin1");
  s = s.replace(/\/CreationDate\s*\([^)]*\)/g, "/CreationDate()");
  s = s.replace(/\/ModDate\s*\([^)]*\)/g, "/ModDate()");
  s = s.replace(/\/ID\s*\[\s*<[^>]+>\s*<[^>]+>\s*\]/g, "/ID[<><>]");
  return createHash("sha256").update(Buffer.from(s, "latin1")).digest("hex");
}

const result = {
  activityId,
  first,
  second,
  byteIdentical: first.sha256 === second.sha256,
  sameSize: first.bytes === second.bytes,
  metaStrippedIdentical: stripMeta(readFileSync(join(outDir, `gen-a-${activityId}.pdf`))) ===
    stripMeta(readFileSync(join(outDir, `gen-b-${activityId}.pdf`))),
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(join(outDir, `determinism-${activityId}.json`), JSON.stringify(result, null, 2));
await context.close();
process.exit(result.byteIdentical ? 0 : 3);
