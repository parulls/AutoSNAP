/**
 * Network-inspect ASPI Aktivitas Pengujian Download vs AutoSNAP navigation capture.
 * Same Activity ID; compare SHA-256 of both paths. No API Execute.
 */
import { Pool } from "pg";
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { decrypt } = require("../backend/dist/security.js");
const { fetchOfficialPdf, pdfContentSha256, validateOfficialPdf } = require("../backend/dist/aspi-evidence.js");

const activityId =
  process.argv[2] ||
  (
    await (async () => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        options: "-c search_path=autosnap,public",
      });
      const row = (
        await pool.query(`
        SELECT request_json->'aspiActivities'->0->>'activityId' AS id
        FROM autosnap_runs
        WHERE status='PASSED'
          AND request_json->'aspiActivities'->0->>'activityId' IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `)
      ).rows[0];
      await pool.end();
      return row?.id;
    })()
  );

if (!activityId) {
  console.error("No activityId");
  process.exit(1);
}

const outDir = join(process.cwd(), "scripts", ".pdf-compare");
mkdirSync(outDir, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const user = (
  await pool.query(
    `SELECT id, name, data FROM autosnap_records WHERE kind='snap_user' ORDER BY updated_at DESC LIMIT 1`,
  )
).rows[0];
await pool.end();

const email = String(user.data.email || user.data.username || "");
const password = user.data.password ? decrypt(String(user.data.password)) : "";
const chrome = [
  process.env.AUTOSNAP_CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean).find(existsSync);

const context = await chromium.launchPersistentContext(
  join(process.cwd(), ".autosnap-browser-profile", "pdf-investigate"),
  {
    executablePath: chrome,
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  },
);
const page = context.pages()[0] || (await context.newPage());

const netLog = [];
const attachNet = (p) => {
  p.on("request", (req) => {
    const u = req.url();
    if (!/aspi-indonesia|download|report|pdf|sandbox/i.test(u)) return;
    netLog.push({
      t: Date.now(),
      type: "req",
      method: req.method(),
      url: u,
      resource: req.resourceType(),
      headers: {
        accept: req.headers()["accept"],
        referer: req.headers()["referer"],
        "content-type": req.headers()["content-type"],
      },
    });
  });
  p.on("response", async (res) => {
    const u = res.url();
    if (!/aspi-indonesia|download|report|pdf|sandbox/i.test(u)) return;
    const ct = res.headers()["content-type"] || "";
    const cd = res.headers()["content-disposition"] || "";
    let head = "";
    let size = -1;
    try {
      if (/pdf|octet-stream|attachment/i.test(ct + cd) || /downloadreportactivity|reportactivity/i.test(u)) {
        const buf = Buffer.from(await res.body().catch(() => Buffer.alloc(0)));
        size = buf.length;
        head = buf.subarray(0, 40).toString("latin1").replace(/\0/g, "\\0");
      }
    } catch {
      /* ignore */
    }
    netLog.push({
      t: Date.now(),
      type: "res",
      status: res.status(),
      url: u,
      contentType: ct,
      disposition: cd,
      size,
      head,
    });
  });
};
attachNet(page);

async function login() {
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
}

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function save(name, buf) {
  const path = join(outDir, name);
  writeFileSync(path, buf);
  return path;
}

console.log(JSON.stringify({ activityId, snapUser: user.name, email }, null, 2));
await login();
console.log("logged_in", page.url());

// Inspect link attributes for this activity
const linkInfo = await page
  .locator(`a[href*="activityId=${activityId}"]`)
  .evaluateAll((nodes) =>
    nodes.map((n) => ({
      text: (n.textContent || "").trim(),
      href: n.getAttribute("href"),
      target: n.getAttribute("target"),
      download: n.getAttribute("download"),
      onclick: n.getAttribute("onclick"),
      rel: n.getAttribute("rel"),
      className: n.className,
    })),
  )
  .catch(() => []);
console.log("links", JSON.stringify(linkInfo, null, 2));

// --- Path A: click Download on activity list (manual UX) ---
const downloadLink = page
  .locator(`a[href*="downloadreportactivity"][href*="activityId=${activityId}"]`)
  .first();
let manualBuf = null;
let manualMeta = { ok: false };
if ((await downloadLink.count()) > 0) {
  const beforeNet = netLog.length;
  const popupPromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  const downloadPromise = Promise.race([
    page.waitForEvent("download", { timeout: 120000 }),
    context.waitForEvent("page").then(async (popup) => {
      attachNet(popup);
      const d = await popup.waitForEvent("download", { timeout: 120000 });
      return d;
    }),
  ]).catch((e) => ({ error: String(e.message || e) }));

  await downloadLink.click({ force: true });
  const popup = await popupPromise;
  const downloadOrErr = await downloadPromise;

  if (downloadOrErr && downloadOrErr.error) {
    // Maybe navigated in-place or opened HTML that then downloads
    const active = popup || page;
    const lateDownload = await active.waitForEvent("download", { timeout: 90000 }).catch((e) => ({
      error: String(e.message || e),
    }));
    if (lateDownload && !lateDownload.error) {
      const path = await lateDownload.path();
      manualBuf = path ? readFileSync(path) : Buffer.alloc(0);
      manualMeta = {
        ok: true,
        path: "click-late-download",
        suggested: lateDownload.suggestedFilename(),
        url: lateDownload.url(),
        bytes: manualBuf.length,
        sha256: sha(manualBuf),
        magic: manualBuf.subarray(0, 5).toString("latin1"),
      };
    } else {
      // Inspect page after click
      const target = popup || page;
      manualMeta = {
        ok: false,
        path: "click-no-download",
        error: downloadOrErr.error || lateDownload?.error,
        url: target.url(),
        title: await target.title().catch(() => ""),
        bodySnippet: (await target.locator("body").innerText().catch(() => "")).slice(0, 400),
      };
    }
  } else if (downloadOrErr && typeof downloadOrErr.suggestedFilename === "function") {
    const path = await downloadOrErr.path();
    manualBuf = path ? readFileSync(path) : Buffer.alloc(0);
    manualMeta = {
      ok: true,
      path: "click-download-event",
      suggested: downloadOrErr.suggestedFilename(),
      url: downloadOrErr.url(),
      bytes: manualBuf.length,
      sha256: sha(manualBuf),
      magic: manualBuf.subarray(0, 5).toString("latin1"),
    };
  }

  const clickNet = netLog.slice(beforeNet);
  console.log("manual_click", JSON.stringify(manualMeta, null, 2));
  console.log(
    "manual_click_network",
    JSON.stringify(
      clickNet.filter((x) => /download|report|pdf|blob/i.test(x.url + (x.disposition || "") + (x.contentType || ""))),
      null,
      2,
    ),
  );
  if (manualBuf?.length) save(`manual-click-${activityId}.pdf`, manualBuf);
} else {
  console.log("manual_click", JSON.stringify({ ok: false, error: "download link not found on page" }));
}

// Return to activity list if navigated away
if (!page.url().includes("aktivitas-aplikasi-pengujian")) {
  await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
}

// --- Path B: AutoSNAP navigation transport ---
const downloadUrl = `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`;
let autoBuf = null;
let autoMeta = { ok: false };
try {
  const before = Date.now();
  autoBuf = await fetchOfficialPdf(page, downloadUrl, Date.now() + 90000, "navigation");
  validateOfficialPdf(autoBuf);
  autoMeta = {
    ok: true,
    path: "autosnap-navigation",
    ms: Date.now() - before,
    bytes: autoBuf.length,
    sha256: pdfContentSha256(autoBuf),
    magic: autoBuf.subarray(0, 5).toString("latin1"),
  };
  save(`autosnap-nav-${activityId}.pdf`, autoBuf);
} catch (e) {
  autoMeta = { ok: false, path: "autosnap-navigation", error: String(e.message || e).slice(0, 400) };
}
console.log("autosnap_navigation", JSON.stringify(autoMeta, null, 2));

// --- Path C: click Download again on a FRESH page after ensuring activity list ---
// Also dump page HTML of downloadreportactivity for client PDF library clues
const inspect = await context.newPage();
attachNet(inspect);
let htmlMeta = {};
try {
  const resp = await inspect.goto(downloadUrl, {
    waitUntil: "networkidle",
    timeout: 90000,
    referer: "https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian",
  });
  const html = await inspect.content();
  save(`download-page-${activityId}.html`, Buffer.from(html, "utf8"));
  const scripts = await inspect.locator("script[src]").evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("src")).filter(Boolean),
  );
  const inlineHits = [];
  for (const re of [
    /jspdf/i,
    /html2canvas/i,
    /pdfmake/i,
    /print\(/i,
    /createObjectURL/i,
    /downloadreport/i,
    /Content-Disposition/i,
    /application\/pdf/i,
    /\.pdf/i,
    /jsPDF/i,
    /html2pdf/i,
  ]) {
    if (re.test(html)) inlineHits.push(String(re));
  }
  htmlMeta = {
    status: resp?.status(),
    contentType: resp?.headers()?.["content-type"],
    disposition: resp?.headers()?.["content-disposition"],
    url: inspect.url(),
    title: await inspect.title(),
    scripts: scripts.slice(0, 40),
    inlineHits,
    htmlBytes: html.length,
  };

  // Wait for any auto-download from the page
  const autoDl = await inspect.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  if (autoDl) {
    const path = await autoDl.path();
    const buf = path ? readFileSync(path) : Buffer.alloc(0);
    htmlMeta.autoDownload = {
      suggested: autoDl.suggestedFilename(),
      url: autoDl.url(),
      bytes: buf.length,
      sha256: sha(buf),
    };
    save(`page-auto-${activityId}.pdf`, buf);
    if (!manualBuf?.length) {
      manualBuf = buf;
      manualMeta = { ok: true, path: "page-auto-download", ...htmlMeta.autoDownload, magic: buf.subarray(0, 5).toString("latin1") };
    }
  }
} catch (e) {
  htmlMeta = { error: String(e.message || e).slice(0, 400) };
} finally {
  await inspect.close().catch(() => undefined);
}
console.log("download_page_inspect", JSON.stringify(htmlMeta, null, 2));

// --- Path D: stored Supabase PDF for this activity if any ---
const pool2 = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const stored = (
  await pool2.query(
    `SELECT run_id, byte_size, content_sha256, length(pdf_data) AS len, encode(digest(pdf_data,'sha256'),'hex') AS live_sha
     FROM autosnap_evidence_pdfs WHERE activity_id=$1 ORDER BY created_at DESC LIMIT 3`,
    [activityId],
  )
).rows;
await pool2.end();
console.log("stored_supabase", JSON.stringify(stored, null, 2));

// Comparison
const comparison = {
  activityId,
  manual: manualMeta,
  autosnap: autoMeta,
  identical:
    manualBuf &&
    autoBuf &&
    manualBuf.length === autoBuf.length &&
    sha(manualBuf) === sha(autoBuf),
  manualSha: manualBuf ? sha(manualBuf) : null,
  autosnapSha: autoBuf ? sha(autoBuf) : null,
  storedMatchesAutosnap: stored[0] && autoBuf ? stored[0].live_sha === sha(autoBuf) : null,
  storedMatchesManual: stored[0] && manualBuf ? stored[0].live_sha === sha(manualBuf) : null,
};
console.log("COMPARISON", JSON.stringify(comparison, null, 2));
writeFileSync(join(outDir, `comparison-${activityId}.json`), JSON.stringify({ comparison, linkInfo, htmlMeta, netSample: netLog.slice(-80) }, null, 2));

await context.close();
process.exit(comparison.identical ? 0 : 2);
