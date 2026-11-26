import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const chrome = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
const history = { runs: [], total: 0, summary: { total: 0, dev: 0, simulator: 0, passed: 0, completed: 0, failed: 0, errors: 0, cancelled: 0 }, byOperator: [], scope: "all" };

test("client simulator uses a scenario name and API services live in master data", { skip: !chrome, timeout: 60000 }, async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { windowsHide: true, stdio: "ignore" });
  let browser;
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 150)); }
    assert.ok(ready);
    const now = new Date().toISOString();
    const records = [
      { id: "snap", kind: "snap_user", name: "QA SNAP", parentId: null, partnerId: null, data: { email: "qa@example.test", displayUsername: "ulitesting" }, createdAt: now, updatedAt: now },
      { id: "prov", kind: "sim_provider", name: "Bank SUMUT", parentId: null, partnerId: null, data: { baseUrl: "https://dev.banksumut.co.id", clientId: "key", partnerId: "9296", channelId: "0001", deviceId: "device-1", signatureAccessTokenMode: "FUNCTION", signatureServiceMode: "FUNCTION" }, createdAt: now, updatedAt: now },
      { id: "other", kind: "sim_provider", name: "Bank ABC", parentId: null, partnerId: null, data: { baseUrl: "https://example.test", clientId: "key", partnerId: "abc-1", channelId: "0002", deviceId: "device-abc" }, createdAt: now, updatedAt: now },
    ];
    let saved;
    let releaseRun = () => {};
    const holdRun = new Promise(resolve => { releaseRun = resolve; });
    let runs = 0;
    let cancelSeen = false;
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage();
    page.on("dialog", dialog => dialog.accept());
    await page.route("**/api/autosnap", async route => {
      const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
      let data;
      if (!input.action) data = { user: { id: "admin", username: "qa", role: "admin", active: true }, records, runs: [], scenarios: [], operators: [] };
      else if (input.action === "getHistory" || input.action === "aspiBusy" || input.action === "getProgress") data = input.action === "aspiBusy" ? { busyUserIds: [] } : input.action === "getProgress" ? { status: "completed", stage: "finished", steps: [] } : history;
      else if (input.action === "save") {
        assert.equal(input.kind, "sim_service");
        assert.equal(input.data.clientSecret, undefined);
        assert.equal(input.data.privateKey, undefined);
        saved = input;
        const id = input.id || "svc";
        const existing = records.find(item => item.id === id);
        const row = { id, kind: "sim_service", name: input.name, parentId: input.parentId, partnerId: null, data: input.data, createdAt: now, updatedAt: now };
        if (existing) Object.assign(existing, row); else records.push(row);
        if (!records.some(item => item.id === "svc-b")) records.push({ id: "svc-b", kind: "sim_service", name: "Transfer", parentId: "other", partnerId: null, data: { method: "POST", path: "/transfer", defaultBody: "{}" }, createdAt: now, updatedAt: now });
        data = { ok: true, id };
      } else if (input.action === "delete") {
        const index = records.findIndex(item => item.id === input.id);
        assert.notEqual(index, -1);
        records.splice(index, 1);
        data = { ok: true };
      } else if (input.action === "runClientSimulator") {
        runs += 1;
        assert.equal(input.scenarioId, "POSITIVE");
        assert.equal(input.scenarioName, undefined);
        assert.equal(input.aspiServiceName, undefined);
        assert.equal(input.testType, undefined);
        if (runs === 1) await holdRun;
        data = { ok: true, status: "COMPLETED", activityName: "Bank SUMUT - Create VA Updated - Positif", pdfReady: false };
      } else if (input.action === "cancelRun") {
        cancelSeen = true;
        data = { ok: true };
      } else if (input.action === "listMasterData") {
        const kind = String(input.kind ?? "");
        let items = kind === "sim_service" ? records.filter(row => row.kind === "sim_service")
          : kind === "sim_provider" ? records.filter(row => row.kind === "sim_provider")
          : kind === "snap_user" ? records.filter(row => row.kind === "snap_user")
          : [];
        if (kind === "sim_service" && input.parentId) items = items.filter(row => row.parentId === input.parentId);
        data = { items, total: items.length, page: Number(input.page ?? 1), pageSize: Number(input.pageSize ?? 20) };
      } else if (input.action === "linkClientServices") {
        data = { ok: true, linkedServiceIds: [] };
      } else throw Error(`Unexpected UI action ${input.action}`);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(base);
    await page.getByRole("navigation").getByRole("button", { name: "Master Data", exact: true }).click();
    await page.getByRole("tab", { name: "API Service Client Simulator", exact: true }).click();
    await page.getByText("Belum ada data.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Tambah API Service Client Simulator" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Penyedia Client Simulator").selectOption("prov");
    await dialog.getByLabel("Nama API Service *").fill("Create VA");
    await dialog.getByLabel("Endpoint *").fill("/api/v1.0/transfer-va/create-va");
    await dialog.getByRole("button", { name: "Simpan", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("cell", { name: "Create VA", exact: true }).waitFor();
    await page.getByRole("row", { name: /Create VA/ }).getByRole("button", { name: "Edit", exact: true }).click();
    await dialog.getByLabel("Nama API Service *").fill("Create VA Updated");
    await dialog.getByRole("button", { name: "Simpan", exact: true }).click();
    await page.getByRole("cell", { name: "Create VA Updated", exact: true }).waitFor();
    await page.getByRole("navigation").getByRole("button", { name: "Client Simulator", exact: true }).click();
    assert.equal(await page.getByLabel("Jenis Pengujian").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Tambah API Service", exact: true }).count(), 0);
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await page.getByText("menekan Send satu kali").count(), 0);
    await page.getByText("Pilih User SNAP, penyedia, API Service, dan skenario.").waitFor();
    const userOptions = await page.getByLabel("User SNAP").locator("option").allTextContents();
    assert.equal(userOptions.includes("ulitesting"), true);
    assert.equal(userOptions.some(option => option.includes("@")), false);
    const scenarioOptions = await page.getByLabel("Skenario Pengujian").locator("option").allTextContents();
    assert.deepEqual(scenarioOptions, ["Pilih Skenario", "Positif", "Access Token Invalid", "Unauthorized . Signature", "Unauthorized . Unknown Client", "Cannot use the same X-EXTERNAL-ID"]);
    await page.getByLabel("User SNAP").selectOption("snap");
    await page.getByLabel("Penyedia Client Simulator").selectOption("prov");
    assert.equal(await page.getByLabel("X-DEVICE-ID").inputValue(), "device-1");
    assert.equal(await page.getByLabel("CHANNEL-ID").inputValue(), "0001");
    assert.equal(await page.getByLabel("X-PARTNER-ID").inputValue(), "9296");
    await page.getByLabel("API Service").selectOption("svc");
    assert.equal(await page.getByLabel("X-DEVICE-ID").inputValue(), "device-1");
    assert.equal(await page.getByLabel("CHANNEL-ID").inputValue(), "0001");
    assert.equal(await page.getByLabel("X-PARTNER-ID").inputValue(), "9296");
    await page.getByRole("button", { name: "Jalankan Testing", exact: true }).click();
    await page.locator(".field-error", { hasText: "Pilih skenario pengujian terlebih dahulu." }).waitFor();
    await page.getByLabel("Skenario Pengujian").selectOption("POSITIVE");
    assert.equal(await page.getByLabel("Service Name ASPI").inputValue(), "Bank SUMUT - Create VA Updated - Positif");
    await page.getByText("200xx00 · opsional").waitFor();
    await page.getByLabel("Skenario Pengujian").selectOption("INVALID_ACCESS_TOKEN");
    assert.equal(await page.getByLabel("Service Name ASPI").inputValue(), "Bank SUMUT - Create VA Updated - Access Token Invalid");
    await page.getByText("401xx01 · opsional").waitFor();
    await page.getByRole("region", { name: "Expected Result" }).getByText("Access Token Invalid", { exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), "autosnap-client-sim-desktop.png"), fullPage: true });
    await page.getByLabel("Skenario Pengujian").selectOption("DUPLICATE_EXTERNAL_ID");
    await page.getByText("Satu baseline ke bank, lalu satu request ASPI dengan External ID yang sama.").waitFor();
    await page.getByRole("button", { name: "Reset Form", exact: true }).click();
    assert.equal(await page.getByLabel("Skenario Pengujian").inputValue(), "");
    assert.equal(await page.getByLabel("Service Name ASPI").inputValue(), "");
    await page.getByText("Pilih skenario pengujian terlebih dahulu.", { exact: true }).waitFor();
    await page.getByLabel("Skenario Pengujian").selectOption("INVALID_ACCESS_TOKEN");
    await page.getByLabel("Penyedia Client Simulator").selectOption("other");
    await page.getByLabel("API Service").selectOption("svc-b");
    assert.equal(await page.getByLabel("Service Name ASPI").inputValue(), "Bank ABC - Transfer - Access Token Invalid");
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    assert.equal(overflow, true);
    await page.screenshot({ path: join(tmpdir(), "autosnap-client-sim-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByLabel("Penyedia Client Simulator").selectOption("prov");
    await page.getByLabel("API Service").selectOption("svc");
    await page.getByLabel("Skenario Pengujian").selectOption("POSITIVE");
    assert.equal(await page.getByLabel("Service Name ASPI").inputValue(), "Bank SUMUT - Create VA Updated - Positif");
    await page.getByRole("button", { name: "Jalankan Testing", exact: true }).click();
    await page.getByRole("button", { name: "Cancel Testing", exact: true }).click();
    for (let i = 0; i < 30 && !cancelSeen; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(cancelSeen, true);
    releaseRun();
    const logDialog=page.getByRole("dialog",{name:"Log Testing"});
    await logDialog.getByRole("button", { name: "Tutup", exact: true }).waitFor({state:"visible"});
    await logDialog.getByRole("button", { name: "Tutup", exact: true }).click();
    await logDialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Jalankan Testing", exact: true }).click();
    await page.getByRole("dialog",{name:"Log Testing"}).getByRole("button", { name: "Tutup", exact: true }).click();
    await page.getByRole("dialog",{name:"Log Testing"}).waitFor({ state: "hidden" });
    await page.getByRole("navigation").getByRole("button", { name: "Master Data", exact: true }).click();
    await page.getByRole("tab", { name: "API Service Client Simulator", exact: true }).click();
    await page.getByLabel("Filter penyedia").selectOption("prov");
    await page.getByRole("row", { name: /Create VA Updated/ }).getByRole("button", { name: "Hapus", exact: true }).click();
    await page.getByRole("dialog", { name: "Konfirmasi Hapus" }).getByRole("button", { name: "Hapus", exact: true }).click();
    await page.getByText("Belum ada data.", { exact: true }).waitFor();
    assert.equal(saved.name, "Create VA Updated");
  } finally { await browser?.close(); server.kill(); }
});
