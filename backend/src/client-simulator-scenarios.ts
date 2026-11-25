export const CLIENT_SIMULATOR_SCENARIO_IDS = ["POSITIVE", "INVALID_ACCESS_TOKEN", "INVALID_SIGNATURE", "UNKNOWN_CLIENT", "DUPLICATE_EXTERNAL_ID"] as const;
export type ClientSimulatorScenario = (typeof CLIENT_SIMULATOR_SCENARIO_IDS)[number];
export type ScenarioMutation = "NONE" | "ACCESS_TOKEN" | "SIGNATURE" | "PARTNER_ID" | "EXTERNAL_ID_REUSE";

export type ScenarioDefinition = {
  id: ClientSimulatorScenario;
  label: string;
  expectedHttp: number;
  codePrefix: "200" | "401" | "409";
  codeSuffix: "00" | "01";
  expectedMessage: string | null;
  mutation: ScenarioMutation;
  summary: string;
};

export const CLIENT_SIMULATOR_SCENARIOS: ScenarioDefinition[] = [
  { id: "POSITIVE", label: "Positif", expectedHttp: 200, codePrefix: "200", codeSuffix: "00", expectedMessage: null, mutation: "NONE", summary: "Request memakai Access Token, signature, Partner ID, dan X-EXTERNAL-ID yang valid." },
  { id: "INVALID_ACCESS_TOKEN", label: "Access Token Invalid", expectedHttp: 401, codePrefix: "401", codeSuffix: "01", expectedMessage: "Access Token Invalid", mutation: "ACCESS_TOKEN", summary: "Signature Service tetap memakai Access Token valid. Token invalid hanya dipakai pada request API Service lewat Client Simulator ASPI." },
  { id: "INVALID_SIGNATURE", label: "Unauthorized . Signature", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Signature", mutation: "SIGNATURE", summary: "X-SIGNATURE pada request API Service berbeda dari signature yang valid. Access Token dan Partner ID tetap valid." },
  { id: "UNKNOWN_CLIENT", label: "Unauthorized . Unknown Client", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Client", mutation: "PARTNER_ID", summary: "X-PARTNER-ID pada request API Service diganti identitas yang tidak dikenal. Access Token dan signature tetap valid." },
  { id: "DUPLICATE_EXTERNAL_ID", label: "Cannot use the same X-EXTERNAL-ID", expectedHttp: 409, codePrefix: "409", codeSuffix: "01", expectedMessage: "Conflict", mutation: "EXTERNAL_ID_REUSE", summary: "X-EXTERNAL-ID diambil dari pengujian sebelumnya yang respons bank-nya sudah sukses (HTTP 2xx). Access Token dan signature tetap valid." },
];

export const DUPLICATE_EXTERNAL_ID_MISSING = "Belum tersedia X-EXTERNAL-ID dari pengujian sebelumnya yang dapat digunakan untuk skenario ini. Jalankan skenario Positif sampai bank menjawab sukses pada hari yang sama, lalu ulangi skenario ini.";
export const UNKNOWN_PARTNER_SENTINEL = "AUTOSNAP-UNKNOWN-CLIENT";

/** Numeric X-EXTERNAL-ID. Bank Sumut SNAP dedup typically keys on digit IDs, not UUID. */
export function mintClientSimulatorExternalId(at = Date.now()) {
  return `${at}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`.slice(0, 36);
}

function bankAcceptedRequest(request: Record<string, unknown>) {
  const actual = request.actual && typeof request.actual === "object" && !Array.isArray(request.actual) ? request.actual as Record<string, unknown> : {};
  const http = Number(actual.httpStatus);
  if (Number.isInteger(http) && http >= 200 && http < 300) return true;
  const code = String(actual.responseCode ?? "").trim();
  return /^2\d{6}$/.test(code);
}

function externalIdFromRequest(request: Record<string, unknown>) {
  const headers = request.headers && typeof request.headers === "object" && !Array.isArray(request.headers) ? request.headers as Record<string, unknown> : {};
  const fromHeader = String(headers["X-EXTERNAL-ID"] ?? headers["x-external-id"] ?? "").trim();
  if (fromHeader) return fromHeader;
  const idempotency = request.idempotency && typeof request.idempotency === "object" && !Array.isArray(request.idempotency) ? request.idempotency as Record<string, unknown> : {};
  return String(idempotency.externalId ?? "").trim();
}

export function clientSimulatorScenario(id: unknown): ScenarioDefinition {
  const found = CLIENT_SIMULATOR_SCENARIOS.find(item => item.id === id);
  if (!found) throw { error: "Skenario pengujian tidak valid. Pilih salah satu dari lima skenario.", status: 400 };
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

/**
 * Expected result for a Client Simulator scenario.
 * HTTP comes from the scenario. SNAP responseCode is used only when the operator filled it.
 * Without a SNAP code, evaluation is HTTP-only (and responseMessage for negative scenarios that need it).
 */
export function resolveScenarioExpectation(scenario: ScenarioDefinition, serviceData: Record<string, unknown>) {
  const configured = configuredSnapCode(serviceData);
  const configuredMessage = String(serviceData.expectedMessage ?? "").trim();
  if (scenario.id === "POSITIVE") {
    const expectedCode = configured && configured.startsWith("200") ? configured : null;
    return { expectedHttp: 200, expectedCode, expectedMessage: configuredMessage || null, ready: true };
  }
  const expectedCode = configured && configured.startsWith(scenario.codePrefix) && configured.endsWith(scenario.codeSuffix) ? configured : null;
  return { expectedHttp: scenario.expectedHttp, expectedCode, expectedMessage: scenario.expectedMessage, ready: true };
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

/**
 * Reuse only an External ID that the bank already accepted.
 * SEND_STARTED alone is not enough — that ID may never have reached the bank.
 * Prefer the header snapshot actually sent, and keep the same WIB calendar day when provided.
 */
export function priorExternalIdFromRuns(rows: { id: string; request: Record<string, unknown> | null }[], scope: { serviceId: string; partnerId: string; day?: string }) {
  for (const row of rows) {
    const request = row.request;
    if (!request) continue;
    if (request.dispatch !== "SENT") continue;
    if (!bankAcceptedRequest(request)) continue;
    const idempotency = request.idempotency && typeof request.idempotency === "object" && !Array.isArray(request.idempotency) ? request.idempotency as Record<string, unknown> : {};
    if (String(idempotency.serviceId ?? "") !== scope.serviceId) continue;
    if (String(idempotency.partnerId ?? "") !== scope.partnerId) continue;
    if (scope.day) {
      const stamp = String(idempotency.timestamp ?? request.timestamp ?? "");
      if (stamp.slice(0, 10) && stamp.slice(0, 10) !== scope.day) continue;
    }
    const externalId = externalIdFromRequest(request);
    if (!externalId) continue;
    return { externalId, sourceRunId: row.id };
  }
  return null;
}
