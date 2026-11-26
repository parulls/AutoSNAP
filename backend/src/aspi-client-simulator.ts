import type { Dialog, Download, Locator, Page } from "playwright-core";
import { validateAspiDownloadPdf } from "./aspi-evidence";
import { evaluateTest, finalOutcome, isHttpResponse, type Evaluation, type RunStatus } from "./test-evaluation";

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
  serviceSource?: "portal" | "unavailable";
  timestamp: string;
  downloadUrl: string;
  text: string;
};

export type ClientSimulatorPortalResult = {
  httpStatus: number | null;
  httpSource?: "target_api" | "portal_metadata_verified" | "unavailable";
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
  missing: () => new ClientSimulatorPortalError("ASPI_ACTIVITY_NOT_FOUND", "Activity ID tersimpan, tetapi barisnya belum ditemukan di Client Simulator Activity. Transaksi tidak dijalankan ulang."),
  ambiguous: () => new ClientSimulatorPortalError("ASPI_ACTIVITY_AMBIGUOUS", "Activity ID muncul lebih dari satu kali. AutoSNAP tidak memilih baris secara acak."),
  trigger: () => new ClientSimulatorPortalError("ASPI_DOWNLOAD_TRIGGER_FAILED", "Tombol Download tidak ada pada baris Activity ID yang dipilih."),
  timeout: () => new ClientSimulatorPortalError("ASPI_DOWNLOAD_TIMEOUT", "Portal ASPI belum menghasilkan file PDF dalam batas waktu pengambilan. Transaksi tidak akan dijalankan ulang."),
  invalid: (detail: string) => new ClientSimulatorPortalError("ASPI_INVALID_PDF", detail || "File yang diterima bukan PDF resmi ASPI yang valid."),
};

export const ACTIVITY_ID_UNAVAILABLE = "Activity ID belum tersedia pada history ini. Bukti tidak dapat diproses ulang secara otomatis karena aktivitas ASPI tidak dapat diidentifikasi secara unik.";

export type SaveResultOutcome = {
  state: "SAVED" | "REDIRECTED" | "AUTH_EXPIRED" | "REJECTED" | "UNKNOWN";
  httpStatus: number | null;
  redirectPath?: string;
  activityId?: string;
  verified: boolean;
  error?: string;
};

export type SimulatorActivityEvidence = {
  runId: string;
  activityId: string;
  serviceId: string;
  serviceName: string;
  testType?: "positive" | "negative" | null;
  scenarioName?: string | null;
  savedAt: string | null;
  downloadUrl: string | null;
  pdfReady: boolean;
  evidenceStatus: "PENDING" | "DOWNLOADING" | "CAPTURED" | "FAILED";
};

/** #serviceName on the ASPI Client Simulator form has no maxlength attribute. 255 keeps the combined name in that field and in evidence metadata. */
export const ASPI_SERVICE_NAME_MAX = 255;
const controlChars = /[\u0000-\u001F\u007F]/;

export function normalizeClientSimulatorComponent(value: unknown, label: string) {
  const empty = label === "Nama Skenario" ? "Nama Skenario wajib diisi sebelum menjalankan Client Simulator." : `${label} wajib diisi.`;
  if (typeof value !== "string") throw { error: empty, status: 400 };
  const withoutControls = value.replace(controlChars, "").trim();
  if (controlChars.test(value)) throw { error: withoutControls ? `${label} tidak boleh berisi baris baru atau karakter kontrol.` : empty, status: 400 };
  const normalized = value.trim().replace(/[ \t\f\v]+/g, " ");
  if (!normalized) throw { error: empty, status: 400 };
  return normalized;
}

/** Provider, API service, and the scenario typed for this run. Nothing is inferred or appended. */
export function buildClientSimulatorServiceName(providerName: string, serviceName: string, scenarioName: string) {
  const provider = normalizeClientSimulatorComponent(providerName, "Nama penyedia");
  const service = normalizeClientSimulatorComponent(serviceName, "Nama service");
  const scenario = normalizeClientSimulatorComponent(scenarioName, "Nama Skenario");
  const combined = `${provider} - ${service} - ${scenario}`;
  if (combined.length > ASPI_SERVICE_NAME_MAX) throw { error: `Service Name ASPI maksimal ${ASPI_SERVICE_NAME_MAX} karakter. Perkecil Nama Skenario.`, status: 400 };
  return combined;
}

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

/** Official ASPI activity identity: UUID or numeric id. Names, timestamps, and row numbers are not ids. */
export function officialActivityId(value: string | null | undefined) {
  const id = String(value ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return id;
  if (/^\d{4,18}$/.test(id)) return id;
  return null;
}

export function safeRedirectPath(location: string | null | undefined) {
  if (!location) return undefined;
  try { return new URL(location, CLIENT_SIMULATOR_FORM).pathname || undefined; }
  catch { return undefined; }
}

/** HTTP status alone never proves SAVED. A redirect is classified by its path, without the query string. */
export function classifySaveHttp(status: number | null, location?: string | null): SaveResultOutcome {
  const redirectPath = safeRedirectPath(location);
  const activityId = officialActivityId(activityIdFromPortalUrl(location || "")) ?? undefined;
  if (status == null) return { state: "UNKNOWN", httpStatus: null, redirectPath, activityId, verified: false, error: "Status Save Result tidak terbaca." };
  if (status >= 400) return { state: "REJECTED", httpStatus: status, redirectPath, activityId, verified: false, error: `ASPI menolak Save Result (HTTP ${status}).` };
  if (status >= 300) {
    if (redirectPath && /\/sign-in|\/login|\/account\/login/i.test(redirectPath)) {
      return { state: "AUTH_EXPIRED", httpStatus: status, redirectPath, verified: false, error: "Sesi ASPI telah berakhir. Login ulang diperlukan sebelum mengambil bukti." };
    }
    if (!redirectPath) return { state: "UNKNOWN", httpStatus: status, verified: false, error: `Save Result mengembalikan HTTP ${status} tanpa tujuan redirect yang dapat diperiksa.` };
    return { state: "REDIRECTED", httpStatus: status, redirectPath, activityId, verified: false };
  }
  return { state: "UNKNOWN", httpStatus: status, redirectPath, activityId, verified: false };
}

export function proveSavedActivity(outcome: SaveResultOutcome, activity: ClientSimulatorActivity | null): SaveResultOutcome {
  const activityId = officialActivityId(activity?.activityId);
  if (!activityId) return outcome;
  return { state: "SAVED", httpStatus: outcome.httpStatus, redirectPath: outcome.redirectPath, activityId, verified: true };
}

export function findActivityById(rows: ClientSimulatorActivity[], activityId: string) {
  const id = officialActivityId(activityId);
  if (!id) return { ok: false as const, code: "ASPI_ACTIVITY_NOT_FOUND" as const };
  const matches = rows.filter(row => officialActivityId(row.activityId) === id);
  if (matches.length === 1) return { ok: true as const, activity: { ...matches[0], activityId: id } };
  return { ok: false as const, code: matches.length === 0 ? "ASPI_ACTIVITY_NOT_FOUND" as const : "ASPI_ACTIVITY_AMBIGUOUS" as const };
}

/** The only post-save association: exactly one official id that was not in the baseline. Service name is not a key. */
export function findNewOfficialActivity(before: Set<string>, rows: ClientSimulatorActivity[]) {
  const known = new Set([...before].map(item => officialActivityId(item) ?? item));
  const fresh = new Map<string, ClientSimulatorActivity>();
  for (const row of rows) {
    const id = officialActivityId(row.activityId);
    if (!id || known.has(id) || fresh.has(id)) continue;
    fresh.set(id, { ...row, activityId: id });
  }
  if (fresh.size === 1) return { ok: true as const, activity: [...fresh.values()][0] };
  if (fresh.size === 0) return { ok: false as const, code: "ACTIVITY_ID_PENDING" as const };
  return { ok: false as const, code: "ACTIVITY_ID_UNRESOLVED" as const };
}

export function pickNewClientSimulatorActivity(before: Set<string>, rows: ClientSimulatorActivity[]) {
  const matched = findNewOfficialActivity(before, rows);
  return matched.ok ? matched.activity : null;
}

/** Exact Activity ID only. A service name never selects a row. */
export function matchClientSimulatorActivity(rows: ClientSimulatorActivity[], target: { activityId?: string; serviceName?: string; before?: Set<string> }): { ok: true; activity: ClientSimulatorActivity } | { ok: false; code: "ASPI_ACTIVITY_NOT_FOUND" | "ASPI_ACTIVITY_AMBIGUOUS" } {
  if (!officialActivityId(target.activityId)) return { ok: false, code: "ASPI_ACTIVITY_NOT_FOUND" };
  return findActivityById(rows, target.activityId ?? "");
}

export function clientSimulatorRetryTarget(activities: { activityId?: string }[], requestedId?: string) {
  const stored = [...new Set(activities.map(item => officialActivityId(item.activityId)).filter((id): id is string => !!id))];
  const requested = officialActivityId(requestedId);
  if (requested) {
    if (!stored.includes(requested)) return { ok: false as const, code: "ASPI_ACTIVITY_NOT_FOUND" as const, message: "Activity ID tidak terdaftar pada history ini." };
    return { ok: true as const, activityId: requested };
  }
  if (stored.length === 0) return { ok: false as const, code: "ACTIVITY_ID_UNRESOLVED" as const, message: ACTIVITY_ID_UNAVAILABLE };
  if (stored.length > 1) return { ok: false as const, code: "ASPI_ACTIVITY_AMBIGUOUS" as const, message: "History ini memiliki lebih dari satu Activity ID. Pilih aktivitas yang akan diambil buktinya." };
  return { ok: true as const, activityId: stored[0] };
}

export function buildSimulatorActivityEvidence(input: { runId: string; activityId: string; serviceId: string; serviceName: string; testType?: "positive" | "negative" | null; scenarioName?: string | null; savedAt?: string | null; downloadUrl?: string | null; pdfReady?: boolean; evidenceStatus?: SimulatorActivityEvidence["evidenceStatus"] }): SimulatorActivityEvidence | null {
  const activityId = officialActivityId(input.activityId);
  if (!activityId) return null;
  return { runId: input.runId, activityId, serviceId: input.serviceId, serviceName: input.serviceName, testType: input.testType ?? null, scenarioName: input.scenarioName ?? null, savedAt: input.savedAt || null, downloadUrl: input.downloadUrl || null, pdfReady: input.pdfReady === true, evidenceStatus: input.evidenceStatus ?? (input.pdfReady ? "CAPTURED" : "PENDING") };
}

const ROW_INDEX = /^\d{1,3}$/;
const ACTIVITY_DATE = /\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/;

/** A column that is only a row number, a date, or an activity id is not a service name. */
export function clientSimulatorServiceLabel(headers: string[], cells: string[]): { service: string; serviceSource: "portal" | "unavailable" } {
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const usable = (value: string) => {
    const text = clean(value);
    if (!text || ROW_INDEX.test(text) || ACTIVITY_DATE.test(text) || uuidPattern.test(text) || /^\d{4,18}$/.test(text) || /download|unduh|detail|view/i.test(text)) return "";
    return text;
  };
  const index = headers.findIndex(header => /service/i.test(clean(header)) && !/\bid\b/i.test(clean(header)));
  const fromHeader = index >= 0 ? usable(cells[index] ?? "") : "";
  if (fromHeader) return { service: fromHeader, serviceSource: "portal" };
  const fromCells = cells.map(usable).find(Boolean) ?? "";
  if (fromCells) return { service: fromCells, serviceSource: "portal" };
  return { service: "", serviceSource: "unavailable" };
}

/**
 * The bank response is target HTTP only when Playwright observed that URL.
 * A Save Result status, an access-token status, or a SNAP responseCode is not that response.
 */
export function classifyTargetHttp(input: { observed: { url: string; status: number }[]; serviceUri: string; portalOrigin?: string }): { httpStatus: number | null; httpVerified: boolean; httpSource: "target_api" | "unavailable" } {
  const portal = input.portalOrigin ?? "https://apidevportal.aspi-indonesia.or.id";
  let service: URL;
  try { service = new URL(input.serviceUri); }
  catch { return { httpStatus: null, httpVerified: false, httpSource: "unavailable" }; }
  if (service.origin === portal) return { httpStatus: null, httpVerified: false, httpSource: "unavailable" };
  const hits = input.observed.filter(item => {
    try {
      const url = new URL(item.url);
      return url.origin === service.origin && url.pathname === service.pathname && isHttpResponse(item.status);
    } catch { return false; }
  });
  const hit = hits.at(-1);
  if (!hit) return { httpStatus: null, httpVerified: false, httpSource: "unavailable" };
  return { httpStatus: hit.status, httpVerified: true, httpSource: "target_api" };
}

/** Adapter into the shared Dev Site evaluator. Explicit expected HTTP/SNAP wins over a legacy testType. */
export function evaluateClientSimulator(input: {
  testType?: "positive" | "negative" | null;
  httpStatus: number | null;
  responseCode: string;
  responseMessage?: string | null;
  expectedHttp: number | null;
  expectedCode: string | null;
  expectedMessage?: string | null;
  httpSource?: "target_api" | "portal_metadata_verified" | "unavailable";
}): { matched: boolean; status: RunStatus; httpVerified: boolean; snapVerified: boolean; evaluation: Evaluation } {
  const explicit = input.expectedHttp != null || !!input.expectedCode || !!input.expectedMessage;
  const negative = input.testType === "negative" && !explicit;
  const evaluated = evaluateTest({
    httpStatus: input.httpStatus,
    expectedHttpStatus: input.expectedHttp ?? (negative ? 400 : undefined),
    actualCode: input.responseCode || null,
    expectedCode: negative ? null : input.expectedCode,
    actualMessage: input.responseMessage,
    expectedMessage: negative ? null : input.expectedMessage,
    negative,
    httpSource: input.httpSource,
  });
  const http = evaluated.evaluation.httpValidation;
  const snap = evaluated.evaluation.snapValidation;
  return {
    matched: evaluated.status === "COMPLETED",
    status: evaluated.status,
    httpVerified: http.performed && http.matches,
    snapVerified: snap.matches === true,
    evaluation: evaluated.evaluation,
  };
}

/** PDF completion uses the stored evaluation. An old snapshot without the shared shape keeps its status. */
export function clientSimulatorEvidenceOutcome(stored: Record<string, unknown> | null | undefined, pdfComplete: boolean, currentStatus: string): RunStatus | string {
  const evaluation = stored && typeof stored === "object" ? stored : null;
  const mode = evaluation?.mode;
  const http = evaluation && typeof evaluation.httpValidation === "object" && evaluation.httpValidation ? evaluation.httpValidation as Evaluation["httpValidation"] : null;
  if (!evaluation || (mode !== "HTTP_ONLY" && mode !== "SNAP_AND_HTTP") || !http) return currentStatus;
  return finalOutcome(evaluation as Evaluation, pdfComplete);
}

/** A crash after Send may already have delivered the transaction. Do not submit it again. */
export function clientSimulatorDispatchOutcome(dispatch: "NOT_SENT" | "SEND_STARTED", aborted: boolean): "UNKNOWN" | "CANCELLED" | "AUTOMATION_ERROR" {
  if (dispatch === "SEND_STARTED") return "UNKNOWN";
  return aborted ? "CANCELLED" : "AUTOMATION_ERROR";
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

async function waitForAspiSimulatorResult(page: Page, signal?: AbortSignal): Promise<{ httpStatus: number | null; response: Record<string, unknown>; responseCode: string; responseMessage: string; text: string }> {
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
      const httpStatus: number | null = null;
      return { httpStatus, response, responseCode: state.responseCode, responseMessage: state.responseMessage, text: state.responseBody };
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
    const location = response.headers()["location"] ?? null;
    let hinted: string | null = null;
    try {
      const parsed = JSON.parse(await response.text()) as { activityId?: unknown; activity_id?: unknown };
      const value = parsed?.activityId ?? parsed?.activity_id;
      hinted = officialActivityId(typeof value === "string" || typeof value === "number" ? String(value) : "");
    } catch { hinted = null; }
    const outcome = classifySaveHttp(response.status(), location);
    if (!outcome.activityId && hinted) outcome.activityId = hinted;
    if (outcome.state === "REJECTED" && dialogMessage) outcome.error = dialogMessage.slice(0, 240);
    return outcome;
  } finally {
    page.off("dialog", onDialog);
  }
}

function saveDiagnosis(outcome: SaveResultOutcome) {
  if (outcome.error) return outcome.error;
  if (outcome.state === "REDIRECTED") return `Save Result HTTP ${outcome.httpStatus} menuju ${outcome.redirectPath}. Penyimpanan belum dibuktikan dengan Activity ID resmi.`;
  if (outcome.httpStatus != null && outcome.httpStatus < 300) return `Save Result HTTP ${outcome.httpStatus}. Activity ID resmi belum ditemukan di Client Simulator Activity.`;
  return "Activity ID resmi belum dapat diverifikasi. Transaksi tidak dijalankan ulang.";
}

export async function readClientSimulatorActivities(page: Page): Promise<ClientSimulatorActivity[]> {
  const location = (() => { try { return new URL(page.url()); } catch { return null; } })();
  if (!location || location.origin !== "https://apidevportal.aspi-indonesia.or.id" || location.pathname !== "/client-simulator-activity") {
    const response = await page.goto(CLIENT_SIMULATOR_ACTIVITY, { waitUntil: "domcontentloaded", timeout: 20000 });
    const here = new URL(page.url());
    if (here.pathname === "/sign-in" || /\/login/i.test(here.pathname)) throw portalError.session();
    if (here.origin !== "https://apidevportal.aspi-indonesia.or.id" || here.pathname !== "/client-simulator-activity") {
      throw portalError.session();
    }
    void response;
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
    const headers = Array.from(row.closest("table")?.querySelectorAll("thead th") ?? []).map(cell => clean(cell.textContent));
    const rowIndex = /^\d{1,3}$/;
    const dated = /\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/;
    const usable = (value: string) => {
      const text = clean(value);
      if (!text || rowIndex.test(text) || dated.test(text) || uuid.test(text) || /^\d{4,18}$/.test(text) || /download|unduh|detail|view/i.test(text)) return "";
      return text;
    };
    const headerIndex = headers.findIndex(header => /service/i.test(header) && !/\bid\b/i.test(header));
    const fromHeader = headerIndex >= 0 ? usable(cells[headerIndex] ?? "") : "";
    const service = fromHeader || cells.map(usable).find(Boolean) || "";
    const serviceSource = service ? "portal" : "unavailable";
    const timestamp = cells.find(cell => dated.test(cell)) ?? "";
    const anchors = Array.from(row.querySelectorAll("a"));
    const link = anchors.find(anchor => /download|unduh/i.test(clean(anchor.textContent)) || /download/i.test(anchor.getAttribute("href") ?? "")) ?? anchors.at(-1);
    const markupId = ((row.innerHTML.match(uuid) ?? [])[0] ?? "").toLowerCase();
    const href = link?.getAttribute("href") ?? "";
    const official = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) || /^\d{4,18}$/.test(value);
    if (!href || /^\s*javascript:/i.test(href)) {
      if (!official(markupId)) return [];
      return [{ activityId: markupId, service, serviceSource, timestamp, downloadUrl: "", text: clean(row.textContent) }];
    }
    let url: URL;
    try { url = new URL(href, origin); } catch { return []; }
    if (url.origin !== origin) return [];
    const query = (url.searchParams.get("activityId") || url.searchParams.get("activity_id") || url.searchParams.get("id") || "").toLowerCase();
    const pathId = (url.pathname.split("/").find(part => (uuid.test(part) && part.length === 36) || /^\d{4,18}$/.test(part)) ?? "").toLowerCase();
    const activityId = official(query) ? query : official(pathId) ? pathId : official(markupId) ? markupId : "";
    if (!activityId) return [];
    return [{ activityId, service, serviceSource, timestamp, downloadUrl: url.toString(), text: clean(row.textContent) }];
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
  const id = officialActivityId(activity.activityId);
  if (!id) throw portalError.missing();
  const row = page.locator(`tbody tr:has(a[href*="${id}"]), tbody tr:has([onclick*="${id}"])`);
  const rowCount = await row.count();
  if (rowCount > 1) throw portalError.ambiguous();
  if (rowCount !== 1) throw portalError.missing();
  const named = row.locator("a,button,input").filter({ hasText: /download|unduh/i });
  if (await named.count() === 1) return named;
  const link = row.locator(`a[href*="${id}"]`);
  if (await link.count() === 1) return link;
  throw portalError.trigger();
}

/** Client Simulator adapter: click Download on the activity row at /client-simulator-activity. Never page.pdf(). */
export async function downloadClientSimulatorActivityPdf(page: Page, activity: ClientSimulatorActivity, timeoutMs = 60000) {
  const here = new URL(page.url());
  if (here.origin !== "https://apidevportal.aspi-indonesia.or.id" || here.pathname !== "/client-simulator-activity") {
    throw portalError.session();
  }
  const control = await downloadControl(page, activity);
  const timeout = Math.max(5000, timeoutMs);
  const started = Date.now();
  // Listen on the activity Page (and popup Page) — not BrowserContext — before click.
  const pageDownload = page.waitForEvent("download", { timeout }).then((download) => ({ kind: "page" as const, download })).catch(() => null);
  const popupPromise = page.waitForEvent("popup", { timeout }).then((popup) => ({ kind: "popup" as const, popup })).catch(() => null);
  try {
    await control.click({ timeout: Math.min(10000, timeout) });
    if (page.url().includes("/sign-in")) throw portalError.session();
  } catch (error) {
    if (error instanceof ClientSimulatorPortalError) throw error;
    throw portalError.trigger();
  }
  console.info("[aspi-pdf]", JSON.stringify({
    module: "client_simulator",
    activityId: officialActivityId(activity.activityId) || activity.activityId,
    path: "/client-simulator-activity",
    triggerPage: "/client-simulator-activity",
    stage: "clicked_download",
  }));
  const first = await Promise.race([
    pageDownload,
    popupPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
  ]);
  try {
    if (first?.kind === "page") {
      return await readPortalDownload(first.download);
    }
    if (first?.kind === "popup") {
      const popup = first.popup;
      try {
        if (new URL(popup.url() || "https://apidevportal.aspi-indonesia.or.id/sign-in").pathname === "/sign-in") throw portalError.session();
        const remaining = Math.max(1000, timeout - (Date.now() - started));
        const download = await popup.waitForEvent("download", { timeout: remaining });
        return await readPortalDownload(download);
      } finally {
        await popup.close().catch(() => undefined);
      }
    }
    const late = await pageDownload;
    if (late?.kind === "page") return await readPortalDownload(late.download);
    throw portalError.timeout();
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
  let formExternalId = form.externalId;
  if (await page.locator("#externalId").count()) {
    formExternalId = String(await page.locator("#externalId").inputValue().catch(() => form.externalId) || form.externalId).trim();
  }
  steps.push({ stage: "form_filled", serviceName: form.serviceName, uri: form.uri, method: form.method, optional: filledOptional, externalId: formExternalId, expectedExternalId: form.externalId });
  if (formExternalId && form.externalId && formExternalId !== form.externalId) {
    throw Error(`Field X-EXTERNAL-ID di form ASPI berisi ${formExternalId}, bukan ${form.externalId}.`);
  }
  await beat?.();
  if (signal?.aborted) throw Error("Pengujian dibatalkan pengguna.");
  await note("api_request", "running", `${form.serviceName} — Send di form ASPI. Menunggu response.`);
  const observed: { url: string; status: number }[] = [];
  const observedRequests: { url: string; externalId: string; partnerId: string }[] = [];
  const onResponse = (response: { url: () => string; status: () => number }) => { observed.push({ url: response.url(), status: response.status() }); };
  const onRequest = (request: { url: () => string; headers: () => Record<string, string> }) => {
    try {
      const target = new URL(request.url());
      const service = new URL(form.uri);
      if (target.origin !== service.origin || target.pathname !== service.pathname) return;
      const headers = request.headers();
      observedRequests.push({
        url: request.url(),
        externalId: String(headers["x-external-id"] ?? headers["X-EXTERNAL-ID"] ?? "").trim(),
        partnerId: String(headers["x-partner-id"] ?? headers["X-PARTNER-ID"] ?? "").trim(),
      });
    } catch { /* ignore malformed URLs */ }
  };
  page.on("response", onResponse);
  page.on("request", onRequest);
  let displayed: Awaited<ReturnType<typeof waitForAspiSimulatorResult>>;
  try {
    await pressSend(page);
    displayed = await waitForAspiSimulatorResult(page, signal);
  } finally {
    page.off("response", onResponse);
    page.off("request", onRequest);
  }
  const targetHttp = classifyTargetHttp({ observed, serviceUri: form.uri });
  displayed = { ...displayed, httpStatus: targetHttp.httpStatus };
  const httpSource = targetHttp.httpSource;
  const bankRequest = observedRequests.at(-1) ?? null;
  steps.push({
    stage: "aspi_send",
    httpStatus: displayed.httpStatus,
    httpSource,
    responseCode: displayed.responseCode,
    expectedExternalId: form.externalId,
    formExternalId,
    sentExternalId: bankRequest?.externalId || null,
    sentPartnerId: bankRequest?.partnerId || null,
    bankRequestUrl: bankRequest?.url || null,
  });
  await note("api_request", "completed", `${form.serviceName} — response ${displayed.responseCode || "diterima"}${bankRequest?.externalId ? ` · X-EXTERNAL-ID terkirim ${bankRequest.externalId}` : ""}.`);
  await beat?.();
  await note("save_result", "running", "Save Result pada form ASPI. Send tidak diulang.");
  let saved: SaveResultOutcome;
  try {
    saved = await saveDisplayedResult(page);
    steps.push({ stage: "save_result", state: saved.state, httpStatus: saved.httpStatus, redirectPath: saved.redirectPath ?? null, activityId: saved.activityId ?? null, verified: saved.verified });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Save Result gagal.";
    steps.push({ stage: "save_result", state: "UNKNOWN", ok: false, error: message });
    await note("save_result", "failed", message);
    return { httpStatus: displayed.httpStatus, httpSource, response: displayed.response, responseText: displayed.text, activity: null, pdf: null, pdfError: message, steps };
  }
  await note("save_redirect", saved.state === "AUTH_EXPIRED" || saved.state === "REJECTED" ? "failed" : "completed", saveDiagnosis(saved));
  if (saved.state === "AUTH_EXPIRED" || saved.state === "REJECTED") {
    return { httpStatus: displayed.httpStatus, httpSource, response: displayed.response, responseText: displayed.text, activity: null, pdf: null, pdfError: saveDiagnosis(saved), steps };
  }
  const baseline = new Set(before.map(row => row.activityId));
  let activity: ClientSimulatorActivity | null = null;
  let matchError: string | null = null;
  await note("activity_id", "running", saved.activityId ? `Mencari Activity ID ${saved.activityId}.` : "Mencari satu Activity ID resmi yang baru.");
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw Error("Pengujian dibatalkan pengguna.");
    const rows = await readClientSimulatorActivities(page);
    const matched = saved.activityId ? findActivityById(rows, saved.activityId) : findNewOfficialActivity(baseline, rows);
    steps.push({ stage: "activity_match", attempt, listed: rows.length, activityId: matched.ok ? matched.activity.activityId : null, code: matched.ok ? null : matched.code });
    if (matched.ok) { activity = matched.activity; break; }
    if (!matched.ok && matched.code === "ACTIVITY_ID_UNRESOLVED") { matchError = "Setelah Save Result muncul lebih dari satu Activity ID baru. AutoSNAP tidak memilih Activity ID secara acak."; break; }
    if (!matched.ok && matched.code === "ASPI_ACTIVITY_AMBIGUOUS") { matchError = portalError.ambiguous().userMessage; break; }
    await note("activity_id", "running", "Activity ID belum terlihat. Membaca ulang Client Simulator Activity.");
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  const proven = proveSavedActivity(saved, activity);
  steps.push({ stage: "activity_id", state: proven.state, activityId: proven.activityId ?? null, verified: proven.verified });
  if (!proven.verified || !activity) {
    const message = matchError || saveDiagnosis(saved);
    await note("activity_id", "failed", message);
    return { httpStatus: displayed.httpStatus, httpSource, response: displayed.response, responseText: displayed.text, activity: null, pdf: null, pdfError: message, steps };
  }
  await note("activity_id", "completed", `Activity ID ${activity.activityId}.`);
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
  return { httpStatus: displayed.httpStatus, httpSource, response: displayed.response, responseText: displayed.text, activity, pdf, pdfError, steps };
}
