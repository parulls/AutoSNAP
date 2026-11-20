/**
 * Live verify: fetchOfficialPdf navigation transport after blob-download fix.
 */
import { Pool } from "pg";
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { decrypt } = require("../backend/dist/security.js");
const { fetchOfficialPdf } = require("../backend/dist/aspi-evidence.js");

const activityIds = process.argv.slice(2);
const ids = activityIds.length
  ? activityIds
  : [
      "3597e432-66b3-4677-8d95-a243b949810c",
      "1c2ac040-58a8-4c03-b28d-87ac3c3d2459",
    ];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  options: "-c search_path=autosnap,public",
});
const chrome = [
  process.env.AUTOSNAP_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean).find(existsSync);
if (!chrome) {
  console.error("Chrome missing");
  process.exit(1);
}
const user = (
  await pool.query(
    `SELECT id, name, data FROM autosnap_records WHERE kind='snap_user' ORDER BY updated_at DESC LIMIT 1`,
  )
).rows[0];
await pool.end();
const email = String(user.data.email || user.data.username || "");
const password = user.data.password ? decrypt(String(user.data.password)) : "";

const context = await chromium.launchPersistentContext(
  `${process.cwd()}/.autosnap-browser-profile/probe-download-fixed`,
  {
    executablePath: chrome,
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  },
);
const page = context.pages()[0] || (await context.newPage());
try {
  await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  if (page.url().includes("sign-in") || (await page.locator('input[type="password"]').count())) {
    await page.locator('input[type="email"],input[name*="email" i]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => undefined),
      page.locator('form button[type="submit"],form input[type="submit"]').first().click(),
    ]);
    await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }
  console.log("logged_in", page.url());
  for (const activityId of ids) {
    const url = `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`;
    const started = Date.now();
    try {
      const pdf = await fetchOfficialPdf(page, url, Date.now() + 60000, "navigation");
      const sha = createHash("sha256").update(pdf).digest("hex");
      const out = `scripts/.probe-${activityId}.pdf`;
      writeFileSync(out, pdf);
      console.log(
        JSON.stringify({
          activityId,
          ok: true,
          ms: Date.now() - started,
          bytes: pdf.length,
          magic: pdf.subarray(0, 5).toString("latin1"),
          sha256: sha,
          saved: out,
        }),
      );
    } catch (e) {
      console.log(
        JSON.stringify({
          activityId,
          ok: false,
          ms: Date.now() - started,
          error: String(e.message || e).slice(0, 300),
        }),
      );
    }
  }
} finally {
  await context.close();
}
