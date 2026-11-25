import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

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
      { id: "snap", kind: "snap_user", name: "QA SNAP", parentId: null, partnerId: null, data: { email: "qa@example.test" }, createdAt: now, updatedAt: now },
      { id: "prov", kind: "sim_provider", name: "Bank SUMUT", parentId: null, partnerId: null, data: { baseUrl: "https://dev.banksumut.co.id", clientKey: "key", channelId: "0001", deviceId: "device-1", signatureAccessTokenMode: "FUNCTION", signatureServiceMode: "FUNCTION" }, createdAt: now, updatedAt: now },
      { id: "other", kind: "sim_provider", name: "Bank ABC", parentId: null, partnerId: null, data: { baseUrl: "https://example.test", clientKey: "key" }, createdAt: now, updatedAt: now },
    ];
    let saved;
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage();
    page.on("dialog", dialog => dialog.accept());
    await page.route("**/api/autosnap", async route => {
      const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
      let data;
      if (!input.action) data = { user: { id: "admin", username: "qa", role: "admin", active: true }, records, runs: [], scenarios: [], operators: [] };
      else if (input.action === "getHistory" || input.action === "aspiBusy" || input.action === "getProgress" || input.action === "cancelRun") data = input.action === "aspiBusy" ? { busyUserIds: [] } : input.action === "getProgress" ? { status: "completed", stage: "finished", steps: [] } : input.action === "cancelRun" ? { ok: true } : history;
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
        assert.equal(input.scenarioName, "Saldo Tidak Cukup");
        assert.equal(input.aspiServiceName, undefined);
        assert.equal(input.testType, undefined);
        data = { ok: true, status: "COMPLETED", activityName: "Bank SUMUT - Create VA - Saldo Tidak Cukup", pdfReady: false };
      } else throw Error(`Unexpected UI action ${input.action}`);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto(base);
    await page.getByRole("navigation").getByRole("button", { name: "Master Data", exact: true }).click();
    await page.getByRole("tab", { name: "API Service Client Simulator", exact: true }).click();
    await page.getByText("Belum ada API Service Client Simulator.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Tambah API Service Client Simulator", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Penyedia Client Simulator").selectOption("prov");
    await dialog.getByText("https://dev.banksumut.co.id").waitFor();
    await dialog.getByLabel("Nama API Service *").fill("Create VA");
    await dialog.getByLabel("Relative Path *").fill("/api/v1.0/transfer-va/create-va");
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
    await page.getByLabel("User SNAP").selectOption("snap");
    await page.getByLabel("Penyedia Client Simulator").selectOption("prov");
    await page.getByLabel("API Service").selectOption("svc");
    await page.getByRole("button", { name: "Jalankan Client Simulator", exact: true }).click();
    await page.locator(".field-error", { hasText: "Nama Skenario wajib diisi sebelum menjalankan Client Simulator." }).waitFor();
    await page.getByLabel("Nama Skenario *").fill("Saldo Tidak Cukup");
    assert.equal(await page.getByLabel("Service Name ASPI").inputValue(), "Bank SUMUT - Create VA Updated - Saldo Tidak Cukup");
    await page.getByLabel("Penyedia Client Simulator").selectOption("other");
    await page.getByLabel("API Service").selectOption("svc-b");
    assert.equal(await page.getByLabel("Service Name ASPI").inputValue(), "Bank ABC - Transfer - Saldo Tidak Cukup");
    await page.getByLabel("Penyedia Client Simulator").selectOption("prov");
    await page.getByLabel("API Service").selectOption("svc");
    assert.equal(await page.getByLabel("Service Name ASPI").inputValue(), "Bank SUMUT - Create VA Updated - Saldo Tidak Cukup");
    await page.getByRole("button", { name: "Jalankan Client Simulator", exact: true }).click();
    await page.getByText("PDF belum tersimpan").waitFor();
    await page.getByRole("button", { name: "Tutup", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Master Data", exact: true }).click();
    await page.getByRole("tab", { name: "API Service Client Simulator", exact: true }).click();
    await page.getByLabel("Filter penyedia").selectOption("prov");
    await page.getByRole("button", { name: "Hapus", exact: true }).click();
    await page.getByText("Tidak ada API Service yang cocok dengan pencarian.", { exact: true }).waitFor();
    assert.equal(saved.name, "Create VA Updated");
  } finally { await browser?.close(); server.kill(); }
});
