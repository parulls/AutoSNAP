/**
 * Probe ASPI downloadreportactivity: click Download vs goto vs View page.
 * Does not execute any SNAP API. Requires Chrome + SNAP credentials in DB.
 */
import { Pool } from "pg";
import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { decrypt } = require("../backend/dist/security.js");

const activityId = process.argv[2] || "3597e432-66b3-4677-8d95-a243b949810c";
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
if (!user) {
  console.error("No snap_user");
  process.exit(1);
}

const email = String(user.data.email || user.data.username || "");
const password = user.data.password ? decrypt(String(user.data.password)) : "";
console.log(JSON.stringify({ snapUser: user.name, email, activityId }, null, 2));

const context = await chromium.launchPersistentContext(
  `${process.cwd()}/.autosnap-browser-profile/probe-download`,
  {
    executablePath: chrome,
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  },
);
const page = context.pages()[0] || (await context.newPage());

async function login() {
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
}

function headInfo(buf) {
  return {
    size: buf.length,
    pdfMagic: buf.subarray(0, 5).toString("latin1"),
    head: buf.subarray(0, 80).toString("latin1").replace(/\0/g, "\\0"),
  };
}

try {
  await login();
  console.log("activity_url", page.url());

  // Probe A: click Download link on activity list (manual UX)
  const downloadLink = page
    .locator(`a[href*="downloadreportactivity"][href*="activityId=${activityId}"]`)
    .first();
  const linkCount = await downloadLink.count();
  console.log("download_link_visible", linkCount > 0);
  if (linkCount > 0) {
    const pending = page.waitForEvent("download", { timeout: 90000 });
    await downloadLink.click({ modifiers: [] });
    try {
      const download = await pending;
      const path = await download.path();
      const buf = path ? readFileSync(path) : Buffer.alloc(0);
      console.log(
        "click_download",
        JSON.stringify(
          {
            suggested: download.suggestedFilename(),
            url: download.url(),
            failure: await download.failure(),
            ...headInfo(buf),
          },
          null,
          2,
        ),
      );
    } catch (e) {
      console.log("click_download_error", String(e.message || e).slice(0, 300));
      console.log("after_click_url", page.url());
      console.log(
        "after_click_body",
        (await page.locator("body").innerText().catch(() => "")).slice(0, 400),
      );
    }
  }

  // Probe B: goto download URL on new page (current AutoSNAP path)
  const url = `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`;
  const report = await context.newPage();
  const downloadWait = report.waitForEvent("download", { timeout: 20000 }).then(
    async (d) => {
      const path = await d.path();
      const buf = path ? readFileSync(path) : Buffer.alloc(0);
      return {
        kind: "download",
        suggested: d.suggestedFilename(),
        url: d.url(),
        ...headInfo(buf),
      };
    },
    (e) => ({ kind: "no-download", error: String(e.message || e).slice(0, 160) }),
  );
  let navMeta = {};
  try {
    const nav = await report.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
      referer: "https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian",
    });
    navMeta = {
      status: nav?.status(),
      contentType: nav?.headers()?.["content-type"],
      disposition: nav?.headers()?.["content-disposition"],
      finalUrl: report.url(),
      title: await report.title().catch(() => ""),
    };
    const body = nav ? Buffer.from(await nav.body()) : Buffer.alloc(0);
    navMeta.body = headInfo(body);
  } catch (e) {
    navMeta = { error: String(e.message || e).slice(0, 250), finalUrl: report.url() };
  }
  const downloadResult = await downloadWait;
  console.log("goto_download", JSON.stringify({ ...navMeta, downloadResult }, null, 2));

  // Probe C: View page embeds / secondary download
  const viewUrl = `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/reportactivity?activityId=${activityId}`;
  const view = await context.newPage();
  try {
    const resp = await view.goto(viewUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const embeds = await view
      .locator("embed,iframe,object,a[download],a[href*='.pdf'],a[href*='download']")
      .evaluateAll((nodes) =>
        nodes.map((n) => ({
          tag: n.tagName,
          href: n.getAttribute("href") || n.getAttribute("src") || "",
          type: n.getAttribute("type") || "",
          text: (n.textContent || "").trim().slice(0, 80),
        })),
      )
      .catch(() => []);
    console.log(
      "view_page",
      JSON.stringify(
        {
          status: resp?.status(),
          contentType: resp?.headers()?.["content-type"],
          url: view.url(),
          title: await view.title().catch(() => ""),
          embeds,
          bodySnippet: (await view.locator("body").innerText().catch(() => "")).slice(0, 500),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.log("view_page_error", String(e.message || e).slice(0, 250));
  } finally {
    await view.close().catch(() => undefined);
  }
  await report.close().catch(() => undefined);
} finally {
  await context.close();
}
