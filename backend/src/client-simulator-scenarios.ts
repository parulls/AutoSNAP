export const CLIENT_SIMULATOR_SCENARIO_IDS = ["CUSTOM", "POSITIVE", "INVALID_ACCESS_TOKEN", "INVALID_SIGNATURE", "UNKNOWN_CLIENT", "DUPLICATE_EXTERNAL_ID"] as const;
export type ClientSimulatorScenario = (typeof CLIENT_SIMULATOR_SCENARIO_IDS)[number];
export type ScenarioMutation = "NONE" | "ACCESS_TOKEN" | "SIGNATURE" | "PARTNER_ID" | "EXTERNAL_ID_REUSE";

export type ScenarioDefinition = {
  id: ClientSimulatorScenario;
  label: string;
  expectedHttp: number | null;
  codePrefix: "200" | "401" | "409" | null;
  codeSuffix: "00" | "01" | null;
  expectedMessage: string | null;
  mutation: ScenarioMutation;
  summary: string;
};

export const CLIENT_SIMULATOR_SCENARIOS: ScenarioDefinition[] = [
  { id: "CUSTOM", label: "Lainnya", expectedHttp: null, codePrefix: null, codeSuffix: null, expectedMessage: null, mutation: "NONE", summary: "Konfigurasi manual: method, path, body, header, dan expected response diisi operator. Access Token dan signature tetap dikelola backend." },
  // POSITIVE retained for History Compatibility — not offered in the new UI dropdown.
  { id: "POSITIVE", label: "Positif", expectedHttp: 200, codePrefix: "200", codeSuffix: "00", expectedMessage: null, mutation: "NONE", summary: "Request memakai Access Token, signature, Partner ID, dan X-EXTERNAL-ID yang valid." },
  { id: "INVALID_ACCESS_TOKEN", label: "Access Token Invalid", expectedHttp: 401, codePrefix: "401", codeSuffix: "01", expectedMessage: "Access Token Invalid", mutation: "ACCESS_TOKEN", summary: "Signature Service tetap memakai Access Token valid. Token invalid hanya dipakai pada request API Service lewat Client Simulator ASPI." },
  { id: "INVALID_SIGNATURE", label: "Unauthorized . Signature", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Signature", mutation: "SIGNATURE", summary: "X-SIGNATURE pada request API Service berbeda dari signature yang valid. Access Token dan Partner ID tetap valid." },
  { id: "UNKNOWN_CLIENT", label: "Unauthorized . Unknown Client", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Client", mutation: "PARTNER_ID", summary: "X-PARTNER-ID pada request API Service diganti identitas yang tidak dikenal. Access Token dan signature tetap valid." },
  { id: "DUPLICATE_EXTERNAL_ID", label: "Cannot use the same X-EXTERNAL-ID", expectedHttp: 409, codePrefix: "409", codeSuffix: "00", expectedMessage: "Conflict", mutation: "EXTERNAL_ID_REUSE", summary: "AutoSNAP membuat X-EXTERNAL-ID baru, mengunci ke bank dengan satu request baseline langsung (bukan ASPI), lalu mengirim ID yang sama lewat Client Simulator ASPI. Hasil pengujian adalah respons ASPI." },
];

/** Scenarios offered in the Client Simulator form (POSITIVE kept only for History). */
export const CLIENT_SIMULATOR_UI_SCENARIOS = CLIENT_SIMULATOR_SCENARIOS.filter((item) => item.id !== "POSITIVE");

export const DUPLICATE_BASELINE_FAILED = "Baseline positif gagal. Request pertama langsung ke bank harus HTTP 200 agar External ID terkunci sebelum uji duplikat lewat ASPI.";
export const DUPLICATE_EXTERNAL_ID_ASPI_MISMATCH = "Form/ASPI tidak mengirim X-EXTERNAL-ID yang sama dengan baseline. AutoSNAP membatalkan evaluasi agar tidak menganggap bank salah.";
export const UNKNOWN_PARTNER_SENTINEL = "AUTOSNAP-UNKNOWN-CLIENT";

/** Numeric X-EXTERNAL-ID. Bank Sumut SNAP dedup typically keys on digit IDs, not UUID. */
export function mintClientSimulatorExternalId(at = Date.now()) {
  return `${at}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`.slice(0, 36);
}

/** Baseline must be a verified positive success — never 409 and never a guessed HTTP. */
export function duplicateBaselineSucceeded(httpStatus: number | null | undefined, responseCode?: string | null, serviceData: Record<string, unknown> = {}) {
  const http = Number(httpStatus);
  if (!(Number.isInteger(http) && http === 200)) return false;
  const code = String(responseCode ?? "").trim();
  const configured = configuredSnapCode(serviceData);
  if (configured && configured.startsWith("200")) return code === configured;
  if (code && !/^2\d{6}$/.test(code)) return false;
  return true;
}

export function clientSimulatorScenario(id: unknown): ScenarioDefinition {
  const found = CLIENT_SIMULATOR_SCENARIOS.find((item) => item.id === id);
  if (!found) throw { error: "Skenario pengujian tidak valid. Pilih Lainnya atau salah satu skenario negatif.", status: 400 };
  return found;
}

export function normalizeSnapMessage(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** Optional SNAP responseCode filled by the operator. Service code is never invented. */
export function configuredSnapCode(serviceData: Record<string, unknown>): string | null {
  const configured = String(serviceData.expectedCode ?? serviceData.expectedSnapCode ?? "").trim();
  return /^\d{7}$/.test(configured) ? configured : null;
}

export type CustomScenarioOverride = {
  scenarioName?: string;
  method?: string;
  path?: string;
  expectedHttpStatus?: string | number | null;
  expectedCode?: string | null;
  expectedMessage?: string | null;
};

/**
 * Expected result for a Client Simulator scenario.
 * CUSTOM uses operator overrides (HTTP is never assumed to be 200).
 * POSITIVE remains for History Compatibility.
 */
export function resolveScenarioExpectation(
  scenario: ScenarioDefinition,
  serviceData: Record<string, unknown>,
  custom?: CustomScenarioOverride | null,
) {
  const configured = configuredSnapCode(serviceData);
  const configuredMessage = String(serviceData.expectedMessage ?? "").trim();
  if (scenario.id === "CUSTOM") {
    const httpRaw = custom?.expectedHttpStatus ?? serviceData.expectedHttpStatus;
    const http = Number(httpRaw);
    if (!(Number.isInteger(http) && http >= 100 && http <= 599)) {
      throw { error: "Expected HTTP Status Lainnya wajib diisi (100–599).", status: 400 };
    }
    const code = String(custom?.expectedCode ?? configured ?? "").trim();
    if (code && !/^\d{7}$/.test(code)) throw { error: "Expected SNAP Code Lainnya harus 7 digit.", status: 400 };
    const message = String(custom?.expectedMessage ?? configuredMessage ?? "").trim() || null;
    return { expectedHttp: http, expectedCode: code || null, expectedMessage: message, ready: true };
  }
  if (scenario.id === "POSITIVE") {
    const expectedCode = configured && configured.startsWith("200") ? configured : null;
    return { expectedHttp: 200, expectedCode, expectedMessage: configuredMessage || null, ready: true };
  }
  let expectedCode = configured && scenario.codePrefix && scenario.codeSuffix && configured.startsWith(scenario.codePrefix) && configured.endsWith(scenario.codeSuffix) ? configured : null;
  if (!expectedCode && scenario.id === "DUPLICATE_EXTERNAL_ID") {
    const serviceCode = String(serviceData.serviceCode ?? "").trim();
    if (/^\d{2}$/.test(serviceCode)) expectedCode = `409${serviceCode}${scenario.codeSuffix}`;
  }
  return { expectedHttp: scenario.expectedHttp ?? 401, expectedCode, expectedMessage: scenario.expectedMessage, ready: true };
}

export function replacementAccessToken(validToken: string) {
  if (!validToken) throw { error: "Access Token valid belum diperoleh, sehingga skenario Access Token Invalid tidak dapat diisolasi.", status: 400 };
  const replacement = "invalid-access-token";
  return replacement === validToken ? "invalid-access-token-2" : replacement;
}

export function corruptSignature(validSignature: string) {
  if (!validSignature) throw { error: "Signature Service valid kosong, sehingga skenario Unauthorized Signature tidak dapat diisolasi.", status: 400 };
  const next = validSignature.endsWith("A") ? "B" : "A";
  const corrupted = `${validSignature.slice(0, -1)}${next}`;
  return corrupted === validSignature ? `${validSignature}x` : corrupted;
}

export function unknownPartnerId(current: string, configured?: string) {
  const candidate = (configured || UNKNOWN_PARTNER_SENTINEL).trim();
  if (!candidate || candidate === current.trim()) throw { error: "Identitas partner uji sama dengan X-PARTNER-ID yang valid. Isi unknownPartnerId yang berbeda pada API Service.", status: 400 };
  return candidate;
}

export function duplicateExternalIdAllowed(baseUrl: string, explicitlyAllowed: boolean) {
  if (explicitlyAllowed) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host.startsWith("dev.") || host.includes(".dev.") || host.includes("sandbox") || host.includes("uat") || /(^|[-.])test([-.]|$)/.test(host);
  } catch {
    return false;
  }
}

/** Canonical Client ID from provider data. Migrates legacy clientKey when clientId is empty. */
export function resolveProviderClientId(data: Record<string, unknown>) {
  const clientId = String(data.clientId ?? "").trim();
  if (clientId) return clientId;
  return String(data.clientKey ?? "").trim();
}

/** Normalize provider payload to clientId-only identity. Returns conflict when both differ. */
export function normalizeProviderClientId(data: Record<string, unknown>) {
  const clientId = String(data.clientId ?? "").trim();
  const legacyKey = String(data.clientKey ?? "").trim();
  if (clientId && legacyKey && clientId !== legacyKey) {
    return { ok: false as const, conflict: true as const, clientId, legacyKey };
  }
  const resolved = clientId || legacyKey;
  if (!resolved) return { ok: false as const, conflict: false as const, clientId: "" };
  const next: Record<string, unknown> = { ...data, clientId: resolved };
  delete next.clientKey;
  return { ok: true as const, conflict: false as const, clientId: resolved, data: next };
}
