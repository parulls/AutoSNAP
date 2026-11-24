import type { Dialog, Download, Locator, Page } from "playwright-core";
import { validateAspiDownloadPdf } from "./aspi-evidence";

/** Official ASPI Client Simulator. The portal is the HTTP client; AutoSNAP fills this form. */
export const CLIENT_SIMULATOR_FORM = "https://apidevportal.aspi-indonesia.or.id/client-simulator";
export const CLIENT_SIMULATOR_ACTIVITY = "https://apidevportal.aspi-indonesia.or.id/client-simulator-activity";

export type ClientSimulatorFormInput = {
  serviceName: string;
  uri: string;
  method: string;
  contentType: string;
  timestamp: string;
  signature: string;
  partnerId: string;
  externalId: string;
  channelId: string;
  body: string;
  authorization?: string;
  deviceId?: string;
  clientKey?: string;
  origin?: string;
  ipAddress?: string;
  latitude?: string;
  longitude?: string;
};

export type ClientSimulatorActivity = {
  activityId: string;
  service: string;
  timestamp: string;
  downloadUrl: string;
  text: string;
};

export type ClientSimulatorPortalResult = {
  httpStatus: number | null;
  response: unknown;
  responseText: string;
  activity: ClientSimulatorActivity | null;
  pdf: Buffer | null;
  pdfError: string | null;
  steps: Record<string, unknown>[];
};

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export class ClientSimulatorPortalError extends Error {
  constructor(readonly code: "ASPI_SESSION_EXPIRED" | "ASPI_LOGIN_REQUIRED" | "ASPI_ACTIVITY_NOT_FOUND" | "ASPI_ACTIVITY_AMBIGUOUS" | "ASPI_DOWNLOAD_TRIGGER_FAILED" | "ASPI_DOWNLOAD_TIMEOUT" | "ASPI_INVALID_PDF" | "ASPI_PDF_STORAGE_FAILED", readonly userMessage: string) {
    super(userMessage);
    this.name = "ClientSimulatorPortalError";
  }
}

const portalError = {
  session: () => new ClientSimulatorPortalError("ASPI_SESSION_EXPIRED", "Sesi ASPI telah berakhir. Login ulang diperlukan sebelum mengambil bukti."),
  missing: () => new ClientSimulatorPortalError("ASPI_ACTIVITY_NOT_FOUND", "Pengujian sudah disimpan, tetapi aktivitas belum ditemukan di portal ASPI. Gunakan Proses Ulang Bukti untuk mencoba mengambil PDF tanpa mengirim ulang transaksi."),
  ambiguous: () => new ClientSimulatorPortalError("ASPI_ACTIVITY_AMBIGUOUS", "Beberapa baris aktivitas memiliki nama service yang sama. AutoSNAP tidak memilih baris secara acak."),
  trigger: () => new ClientSimulatorPortalError("ASPI_DOWNLOAD_TRIGGER_FAILED", "Tombol Download tidak ada pada baris aktivitas yang cocok."),
  timeout: () => new ClientSimulatorPortalError("ASPI_DOWNLOAD_TIMEOUT", "Portal ASPI belum menghasilkan file PDF dalam batas waktu pengambilan. Transaksi tidak akan dijalankan ulang."),
  invalid: (detail: string) => new ClientSimulatorPortalError("ASPI_INVALID_PDF", detail || "File yang diterima bukan PDF resmi ASPI yang valid."),
};

export function clientSimulatorServiceName(name: string, testType: "positive" | "negative") {
  const base = name.trim().replace(/\s+/g, " ");
  if (!base) throw Error("Nama service kosong.");
  if (/positive case|negative case/i.test(base)) return base;
  return `${base} - ${testType === "positive" ? "Positive Case" : "Negative Case"}`;
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Activity id printed on an ASPI Client Simulator download link. Other origins are rejected. */
export function activityIdFromPortalUrl(href: string) {
  let url: URL;
  try { url = new URL(href, CLIENT_SIMULATOR_ACTIVITY); } catch { return null; }
  if (url.origin !== "https://apidevportal.aspi-indonesia.or.id" || url.username || url.password) return null;
  const query = url.searchParams.get("activityId") || url.searchParams.get("activity_id") || url.searchParams.get("id") || "";
  if (uuidPattern.test(query) && query.length === 36) return query.toLowerCase();
  if (/^\d{1,18}$/.test(query)) return query;
  const pathId = url.pathname.split("/").find(part => uuidPattern.test(part) && part.length === 36 || /^\d{4,18}$/.test(part));
  return pathId ? pathId.toLowerCase() : null;
}

/**
 * A new Client Simulator Activity row must be the only one whose text contains the Service Name we typed.
 * An unseen row with a different name is left unmatched.
 */
export function pickNewClientSimulatorActivity(before: Set<string>, rows: ClientSimulatorActivity[], serviceName: string) {
  const matched = matchClientSimulatorActivity(rows, { serviceName, before });
  return matched.ok ? matched.activity : null;
}

/** One verified row. A repeated service name without a unique Activity ID is ambiguous, not the first row. */
export function matchClientSimulatorActivity(rows: ClientSimulatorActivity[], target: { activityId?: string; serviceName?: string; before?: Set<string> }): { ok: true; activity: ClientSimulatorActivity } | { ok: false; code: "ASPI_ACTIVITY_NOT_FOUND" | "ASPI_ACTIVITY_AMBIGUOUS" } {
  const fresh = target.before ? rows.filter(row => row.activityId && !target.before!.has(row.activityId)) : rows.filter(row => row.activityId);
  const id = target.activityId?.trim().toLowerCase() ?? "";
  if (id) {
    const byId = fresh.filter(row => row.activityId.toLowerCase() === id || row.downloadUrl.toLowerCase().includes(id) || row.text.toLowerCase().includes(id));
    if (byId.length === 1) return { ok: true, activity: byId[0] };
    if (byId.length > 1) return { ok: false, code: "ASPI_ACTIVITY_AMBIGUOUS" };
  }
  const needle = normalize(target.serviceName ?? "");
  if (needle.length < 4) return { ok: false, code: "ASPI_ACTIVITY_NOT_FOUND" };
  const named = fresh.filter(row => normalize(`${row.service} ${row.text}`).includes(needle));
  if (named.length === 1) return { ok: true, activity: named[0] };
  if (named.length > 1) return { ok: false, code: "ASPI_ACTIVITY_AMBIGUOUS" };
  return { ok: false, code: "ASPI_ACTIVITY_NOT_FOUND" };
}

export function evaluateClientSimulator(input: {
  testType: "positive" | "negative";
  httpStatus: number | null;
  responseCode: string;
  expectedHttp: number | null;
  expectedCode: string | null;
}): { matched: boolean; status: "PASSED" | "FAILED" | "COMPLETED" } {
  const { testType, httpStatus, responseCode, expectedHttp, expectedCode } = input;
  if (httpStatus == null && !responseCode) return { matched: false, status: "COMPLETED" };
  let matched = false;
  if (testType === "positive") {
    if (expectedCode) matched = responseCode === expectedCode && (expectedHttp ? httpStatus === expectedHttp || httpStatus == null : true);
    else if (expectedHttp) matched = httpStatus === expectedHttp || (httpStatus == null && expectedHttp >= 200 && expectedHttp < 300 && /^200\d{2}/.test(responseCode));
    else matched = (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) || /^200\d{2}/.test(responseCode);
  } else {
    matched = expectedHttp ? httpStatus === expectedHttp : httpStatus !== null ? httpStatus >= 400 : !/^200/.test(responseCode);
  }
  return { matched, status: matched ? "PASSED" : "FAILED" };
}

const mandatoryFields: { label: string; pattern: RegExp; key: keyof ClientSimulatorFormInput }[] = [
  { label: "Service Name", pattern: /service\s*name/i, key: "serviceName" },
  { label: "URI", pattern: /(?:^|\s)uri(?:\s|$)/i, key: "uri" },
  { label: "HTTP Method", pattern: /http\s*method|(?:^|\s)method(?:\s|$)/i, key: "method" },
  { label: "Content-Type", pattern: /content-?\s*type/i, key: "contentType" },
  { label: "X-TIMESTAMP", pattern: /x-timestamp/i, key: "timestamp" },
  { label: "X-SIGNATURE", pattern: /x-signature/i, key: "signature" },
  { label: "X-PARTNER-ID", pattern: /x-partner-id/i, key: "partnerId" },
  { label: "X-EXTERNAL-ID", pattern: /x-external-id/i, key: "externalId" },
  { label: "CHANNEL-ID", pattern: /channel-id/i, key: "channelId" },
  { label: "Body", pattern: /(?:^|\s)body(?:\s|$)|request\s*body/i, key: "body" },
];

async function controlForLabel(page: Page, pattern: RegExp) {
  const labeled = page.getByLabel(pattern);
  if (await labeled.count()) return labeled.first();
  const rows = page.locator("tr, .form-group, .mb-3, .field, .form-field");
  const count = await rows.count();
  for (let index = 0; index < Math.min(count, 120); index++) {
    const row = rows.nth(index);
    const text = ((await row.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!pattern.test(text)) continue;
    const controls = row.locator("input:not([type='hidden']), textarea, select");
    if (await controls.count() === 1) return controls.first();
  }
  return null;
}

async function writeControl(control: Locator, value: string, label: string) {
  const tag = await control.evaluate(element => element.tagName.toLowerCase());
  if (tag === "select") {
    const byLabel = await control.selectOption({ label: value }).catch(() => null);
    if (!byLabel?.length) {
      const byValue = await control.selectOption(value).catch(() => null);
      if (!byValue?.length) throw Error(`Field ${label} di form Client Simulator ASPI tidak punya pilihan ${value}.`);
    }
    return;
  }
  await control.fill(value);
}

export async function fillClientSimulatorForm(page: Page, form: ClientSimulatorFormInput) {
  if (await page.locator("#serviceName").count()) {
    const required: [string, string, string][] = [
      ["serviceName", form.serviceName, "Service Name"],
      ["uri", form.uri, "URI"],
      ["httpMethod", form.method, "HTTP Method"],
      ["contentType", form.contentType || "application/json", "Content-Type"],
      ["timestamp", form.timestamp, "X-TIMESTAMP"],
      ["signature", form.signature, "X-SIGNATURE"],
      ["partnerId", form.partnerId, "X-PARTNER-ID"],
      ["externalId", form.externalId, "X-EXTERNAL-ID"],
      ["channelId", form.channelId, "CHANNEL-ID"],
      ["bodyRequest", form.body, "Body"],
    ];
    for (const [id, value, label] of required) {
      const control = page.locator(`#${id}`);
      if (!(await control.count())) throw Error(`Form Client Simulator ASPI tidak memiliki field: ${label}.`);
      await writeControl(control, value, label);
    }
    const filledOptional: string[] = [];
    for (const [id, value, label] of [["authorization", form.authorization, "Authorization"], ["deviceId", form.deviceId, "X-DEVICE-ID"], ["origin", form.origin, "ORIGIN"], ["ipAddress", form.ipAddress, "X-IP-ADDRESS"], ["latitude", form.latitude, "X-LATITUDE"], ["longitude", form.longitude, "X-LONGITUDE"]] as [string, string | undefined, string][]) {
      if (!value) continue;
      const control = page.locator(`#${id}`);
      if (!(await control.count())) continue;
      await writeControl(control, value, label);
      filledOptional.push(label);
    }
    return filledOptional;
  }
  const missing: string[] = [];
  for (const field of mandatoryFields) {
    const control = await controlForLabel(page, field.pattern);
    const raw = form[field.key];
    if (!control) { missing.push(field.label); continue; }
    await writeControl(control, String(raw ?? ""), field.label);
  }
  if (missing.length) throw Error(`Form Client Simulator ASPI tidak memiliki field: ${missing.join(", ")}.`);
  const optional: { pattern: RegExp; value?: string; label: string }[] = [
    { label: "Authorization", pattern: /authorization|access\s*token/i, value: form.authorization },
    { label: "X-DEVICE-ID", pattern: /x-device-id/i, value: form.deviceId },
    { label: "X-CLIENT-KEY", pattern: /x-client-key/i, value: form.clientKey },
    { label: "ORIGIN", pattern: /(?:^|\s)origin(?:\s|$)/i, value: form.origin },
    { label: "X-IP-ADDRESS", pattern: /x-ip-address/i, value: form.ipAddress },
    { label: "X-LATITUDE", pattern: /x-latitude/i, value: form.latitude },
    { label: "X-LONGITUDE", pattern: /x-longitude/i, value: form.longitude },
  ];
  const filledOptional: string[] = [];
  for (const field of optional) {
    if (!field.value) continue;
    const control = await controlForLabel(page, field.pattern);
    if (!control) continue;
    await writeControl(control, field.value, field.label);
    filledOptional.push(field.label);
  }
  return filledOptional;
}

/** The Send button calls myFunction(). Its label is "Send" plus a hidden icon, so an exact text locator misses it. */
async function pressSend(page: Page) {
  await page.waitForFunction(() => typeof (window as unknown as { myFunction?: unknown }).myFunction === "function", { timeout: 20000 });
  await page.evaluate(() => {
    const send = (window as unknown as { myFunction?: () => void }).myFunction;
    if (typeof send !== "function") throw Error("Fungsi Send tidak ada di form ASPI.");
    send();
  });
}

async function waitForAspiSimulatorResult(page: Page, signal?: AbortSignal) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    if (signal?.aborted) throw Error("Pengujian dibatalkan pengguna.");
    const state = await page.evaluate(() => {
      const text = (id: string) => (document.getElementById(id)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const shown = (id: string) => {
        const node = document.getElementById(id);
        return !!node && getComputedStyle(node).display !== "none";
      };
      return {
        invalid: shown("invalidfield") ? text("invalidmsg") : "",
        responseCode: text("responseCode"),
        responseMessage: text("responseMessage"),
        responseBody: text("responseBody").slice(0, 8000),
        responseVisible: shown("responseCall"),
      };
    });
    if (state.invalid) throw Error(state.invalid);
    if (state.responseVisible && (state.responseCode || state.responseBody)) {
      let response: Record<string, unknown> = { responseCode: state.responseCode, responseMessage: state.responseMessage };
      try {
        const parsed = JSON.parse(state.responseBody);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) response = { ...parsed, responseCode: String((parsed as { responseCode?: unknown }).responseCode ?? state.responseCode), responseMessage: String((parsed as { responseMessage?: unknown }).responseMessage ?? state.responseMessage) };
      } catch { response = { ...response, body: state.responseBody }; }
      const http = state.responseBody.match(/HTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})/i);
      return { httpStatus: http ? Number(http[1]) : null, response, responseCode: state.responseCode, responseMessage: state.responseMessage, text: state.responseBody };
    }
    await page.waitForTimeout(500);
  }
  throw Error("Form ASPI tidak menampilkan response setelah Send. Hasil belum disimpan.");
}

async function saveDisplayedResult(page: Page) {
  let dialogMessage = "";
  const onDialog = async (dialog: Dialog) => {
    dialogMessage = dialog.message();
    await dialog.accept().catch(() => undefined);
  };
  page.on("dialog", onDialog);
  try {
    const posted = page.waitForResponse(response => {
      try { return new URL(response.url()).pathname.toLowerCase().includes("clientsimulatorsave"); }
      catch { return false; }
    }, { timeout: 25000 });
    await page.evaluate(() => {
      const saver = (globalThis as { saveResult?: () => void }).saveResult;
      if (typeof saver !== "function") throw Error("Fungsi saveResult tidak ada di form ASPI.");
      saver();
    });
    const response = await posted;
    await page.waitForTimeout(800);
    if (!response.ok()) throw Error(`ASPI menolak Save Result (HTTP ${response.status()}).`);
    if (dialogMessage && !/save/i.test(dialogMessage)) throw Error(dialogMessage);
    return dialogMessage || `HTTP ${response.status()}`;
  } finally {
    page.off("dialog", onDialog);
  }
}

export async function readClientSimulatorActivities(page: Page): Promise<ClientSimulatorActivity[]> {
  const location = (() => { try { return new URL(page.url()); } catch { return null; } })();
  if (!location || location.origin !== "https://apidevportal.aspi-indonesia.or.id" || location.pathname !== "/client-simulator-activity") {
    const response = await page.goto(CLIENT_SIMULATOR_ACTIVITY, { waitUntil: "domcontentloaded", timeout: 20000 });
    const here = new URL(page.url());
    if (here.origin !== "https://apidevportal.aspi-indonesia.or.id" || here.pathname !== "/client-simulator-activity") {
      throw Error("Halaman Client Simulator Activity dialihkan. Periksa login ASPI.");
    }
    if (response && !response.ok()) throw Error(`Client Simulator Activity mengembalikan HTTP ${response.status()}.`);
  }
  const lengthSelect = page.locator('select[name$="_length"], .dataTables_length select').first();
  if (await lengthSelect.count()) {
    const options = await lengthSelect.locator("option").evaluateAll(nodes => nodes.map(node => ({ value: (node as HTMLOptionElement).value, label: (node.textContent ?? "").trim() })));
    const preferred = options.find(item => /all|semua|-1/i.test(item.label) || item.value === "-1") ?? options.find(item => Number(item.value) >= 50) ?? options.at(-1);
    if (preferred) await lengthSelect.selectOption(preferred.value).catch(() => undefined);
  }
  const rows = page.locator("table tbody tr");
  await rows.first().waitFor({ state: "attached", timeout: 8000 }).catch(() => undefined);
  return rows.evaluateAll((rowNodes, origin: string) => rowNodes.flatMap(row => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    if (row.classList.contains("dataTables_empty") || /^(no data|no matching|belum ada|tidak ada|empty)/i.test(clean(row.textContent).slice(0, 80))) return [];
    const cells = Array.from(row.querySelectorAll("td")).map(cell => clean(cell.textContent));
    if (!cells.length) return [];
    const anchors = Array.from(row.querySelectorAll("a"));
    const link = anchors.find(anchor => /download|unduh/i.test(clean(anchor.textContent)) || /download/i.test(anchor.getAttribute("href") ?? "")) ?? anchors.at(-1);
    const markupId = (row.innerHTML.match(uuid) ?? [])[0] ?? "";
    const href = link?.getAttribute("href") ?? "";
    const fallbackId = markupId || clean(`${cells[1] ?? ""}-${cells[2] ?? ""}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    if (!href || /^\s*javascript:/i.test(href)) {
      if (fallbackId.length < 4) return [];
      const service = cells[2] || cells.find(cell => cell && !/download|unduh|detail|view/i.test(cell)) || clean(row.textContent).slice(0, 180);
      return [{ activityId: fallbackId, service, timestamp: cells[1] ?? "", downloadUrl: "", text: clean(row.textContent) }];
    }
    let url: URL;
    try { url = new URL(href, origin); } catch { return []; }
    if (url.origin !== origin) return [];
    const query = url.searchParams.get("activityId") || url.searchParams.get("activity_id") || url.searchParams.get("id") || "";
    const pathId = url.pathname.split("/").find(part => (uuid.test(part) && part.length === 36) || /^\d{4,18}$/.test(part)) ?? "";
    const rowId = (clean(row.textContent).match(uuid) ?? [])[0] ?? "";
    const activityId = ((uuid.test(query) && query.length === 36) || /^\d{1,18}$/.test(query) ? query : pathId || rowId || fallbackId).toLowerCase();
    if (!activityId || activityId.length < 4) return [];
    const service = cells.find(cell => cell && !/download|unduh/i.test(cell) && !uuid.test(cell)) ?? clean(row.textContent).slice(0, 180);
    const timestamp = cells.find(cell => /\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(cell)) ?? "";
    return [{ activityId, service, timestamp, downloadUrl: url.toString(), text: clean(row.textContent) }];
  }), "https://apidevportal.aspi-indonesia.or.id");
}

async function readPortalDownload(download: Download) {
  const actual = download.url();
  if (!actual.startsWith("blob:")) {
    const parsed = new URL(actual);
    if (parsed.origin !== "https://apidevportal.aspi-indonesia.or.id" || parsed.pathname === "/sign-in" || parsed.pathname === "/client-simulator" || parsed.pathname === "/client-simulator-activity") {
      throw Error("Unduhan Client Simulator bukan file Download ASPI.");
    }
  }
  const stream = await download.createReadStream();
  if (!stream) throw Error("Unduhan PDF Client Simulator tidak menyediakan stream binary.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 15 * 1024 * 1024) { stream.destroy(); await download.cancel(); throw Error("Laporan Client Simulator melebihi 15 MB."); }
    chunks.push(bytes);
  }
  return validateAspiDownloadPdf(Buffer.concat(chunks));
}

async function downloadControl(page: Page, activity: ClientSimulatorActivity) {
  if (!/^[a-z0-9-]{4,40}$/i.test(activity.activityId)) throw portalError.missing();
  const id = activity.activityId.replace(/[^a-z0-9-]/gi, "");
  const byId = page.locator(`tbody tr a[href*="${id}"], tbody tr button[onclick*="${id}"], tbody tr a[onclick*="${id}"]`);
  const idCount = await byId.count();
  if (idCount > 1) throw portalError.ambiguous();
  if (idCount === 1) return byId;
  const rows = page.locator("tbody tr").filter({ hasText: activity.service });
  const rowCount = await rows.count();
  if (rowCount > 1) throw portalError.ambiguous();
  if (rowCount !== 1) throw portalError.missing();
  const control = rows.locator("a,button,input").filter({ hasText: /download|unduh/i });
  if (await control.count() !== 1) throw portalError.trigger();
  return control;
}

/** Click Download on the matched activity row and keep the file that click produces. Never page.pdf(). */
export async function downloadClientSimulatorActivityPdf(page: Page, activity: ClientSimulatorActivity) {
  const here = new URL(page.url());
  if (here.origin !== "https://apidevportal.aspi-indonesia.or.id" || here.pathname !== "/client-simulator-activity") {
    throw portalError.session();
  }
  const control = await downloadControl(page, activity);
  const downloadPromise = page.context().waitForEvent("download", { timeout: 60000 });
  const popupPromise = page.context().waitForEvent("page", { timeout: 60000 }).catch(() => null);
  try {
    await control.click({ timeout: 10000 });
    if (page.url().includes("/sign-in")) throw portalError.session();
  } catch (error) {
    if (error instanceof ClientSimulatorPortalError) throw error;
    throw portalError.trigger();
  }
  const popup = await Promise.race([popupPromise, downloadPromise.then(() => null)]).catch(() => null);
  if (popup && new URL(popup.url() || "https://apidevportal.aspi-indonesia.or.id/sign-in").pathname === "/sign-in") throw portalError.session();
  try {
    return await readPortalDownload(await downloadPromise);
  } catch (error) {
    if (error instanceof ClientSimulatorPortalError) throw error;
    if (error instanceof Error && /timeout/i.test(error.message)) throw portalError.timeout();
    throw error instanceof Error && /PDF|html2pdf|bukan/i.test(error.message) ? portalError.invalid(error.message) : portalError.timeout();
  }
}

export async function runClientSimulatorOnPage(page: Page, form: ClientSimulatorFormInput, beat?: () => void, report?: (stage: string, status: "running" | "completed" | "failed", detail?: string) => Promise<void> | void, signal?: AbortSignal): Promise<ClientSimulatorPortalResult> {
  const steps: Record<string, unknown>[] = [];
  const note = async (stage: string, status: "running" | "completed" | "failed", detail: string) => { await report?.(stage, status, detail); };
  if (signal?.aborted) throw Error("Pengujian dibatalkan pengguna.");
  await beat?.();
  await note("api_request", "running", "Membuka Client Simulator Activity untuk daftar awal.");
  const before = await readClientSimulatorActivities(page);
  steps.push({ stage: "activity_baseline", count: before.length });
  await note("api_request", "running", "Mengisi form Client Simulator ASPI.");
  const response = await page.goto(CLIENT_SIMULATOR_FORM, { waitUntil: "domcontentloaded", timeout: 60000 });
  const formUrl = new URL(page.url());
  if (formUrl.origin !== "https://apidevportal.aspi-indonesia.or.id" || formUrl.pathname !== "/client-simulator") {
    throw Error("Form Client Simulator ASPI tidak terbuka.");
  }
  if (response && !response.ok()) throw Error(`Form Client Simulator ASPI mengembalikan HTTP ${response.status()}.`);
  const filledOptional = await fillClientSimulatorForm(page, form);
  steps.push({ stage: "form_filled", serviceName: form.serviceName, uri: form.uri, method: form.method, optional: filledOptional });
  await beat?.();
  if (signal?.aborted) throw Error("Pengujian dibatalkan pengguna.");
  await note("api_request", "running", `${form.serviceName} — Send di form ASPI. Menunggu response.`);
  await pressSend(page);
  const displayed = await waitForAspiSimulatorResult(page, signal);
  steps.push({ stage: "aspi_send", httpStatus: displayed.httpStatus, responseCode: displayed.responseCode });
  await note("api_request", "completed", `${form.serviceName} — response ${displayed.responseCode || "diterima"}.`);
  await beat?.();
  await note("pdf_download", "running", "Save Result, lalu menunggu Download di Client Simulator Activity.");
  try {
    const confirmation = await saveDisplayedResult(page);
    steps.push({ stage: "save_result", ok: true, confirmation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Save Result gagal.";
    steps.push({ stage: "save_result", ok: false, error: message });
    await note("pdf_download", "failed", message);
    return { httpStatus: displayed.httpStatus, response: displayed.response, responseText: displayed.text, activity: null, pdf: null, pdfError: `${message} Hasil tidak masuk ke Client Simulator Activity.`, steps };
  }
  let activity: ClientSimulatorActivity | null = null;
  let matchError: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw Error("Pengujian dibatalkan pengguna.");
    const rows = await readClientSimulatorActivities(page);
    const matched = matchClientSimulatorActivity(rows, { serviceName: form.serviceName, before: new Set(before.map(row => row.activityId)) });
    steps.push({ stage: "activity_match", attempt, listed: rows.length, activityId: matched.ok ? matched.activity.activityId : null, code: matched.ok ? null : matched.code });
    if (matched.ok) { activity = matched.activity; break; }
    if (matched.code === "ASPI_ACTIVITY_AMBIGUOUS") { matchError = portalError.ambiguous().userMessage; break; }
    await note("pdf_download", "running", "Hasil tersimpan. Menunggu baris baru di Client Simulator Activity.");
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  if (!activity) {
    const message = matchError || portalError.missing().userMessage;
    await note("pdf_download", "failed", message);
    return { httpStatus: displayed.httpStatus, response: displayed.response, responseText: displayed.text, activity: null, pdf: null, pdfError: message, steps };
  }
  let pdf: Buffer | null = null;
  let pdfError: string | null = null;
  try {
    await note("pdf_download", "running", `${activity.service} — mengklik Download dan menunggu file PDF.`);
    pdf = await downloadClientSimulatorActivityPdf(page, activity);
    steps.push({ stage: "pdf_download", activityId: activity.activityId, bytes: pdf.length });
    await note("pdf_download", "completed", `PDF resmi ASPI ${pdf.length} byte.`);
  } catch (error) {
    pdfError = error instanceof Error ? error.message : "PDF Client Simulator gagal diunduh.";
    steps.push({ stage: "pdf_download", activityId: activity.activityId, error: pdfError });
    await note("pdf_download", "failed", pdfError);
  }
  return { httpStatus: displayed.httpStatus, response: displayed.response, responseText: displayed.text, activity, pdf, pdfError, steps };
}
