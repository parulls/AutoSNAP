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
  { id: "INVALID_ACCESS_TOKEN", label: "Access Token Invalid", expectedHttp: 401, codePrefix: "401", codeSuffix: "01", expectedMessage: "Access Token Invalid", mutation: "ACCESS_TOKEN", summary: "Request API Service memakai Access Token yang sengaja tidak valid. Signature dihitung terhadap token yang dikirim." },
  { id: "INVALID_SIGNATURE", label: "Unauthorized . Signature", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Signature", mutation: "SIGNATURE", summary: "X-SIGNATURE pada request API Service berbeda dari signature yang valid. Access Token dan Partner ID tetap valid." },
  { id: "UNKNOWN_CLIENT", label: "Unauthorized . Unknown Client", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Client", mutation: "PARTNER_ID", summary: "X-PARTNER-ID pada request API Service diganti identitas yang tidak dikenal. Access Token dan signature tetap valid." },
  { id: "DUPLICATE_EXTERNAL_ID", label: "Cannot use the same X-EXTERNAL-ID", expectedHttp: 409, codePrefix: "409", codeSuffix: "01", expectedMessage: "Conflict", mutation: "EXTERNAL_ID_REUSE", summary: "X-EXTERNAL-ID diambil dari pengujian sebelumnya yang sudah terkirim. Access Token dan signature tetap valid." },
];

export const DUPLICATE_EXTERNAL_ID_MISSING = "Belum tersedia X-EXTERNAL-ID dari pengujian sebelumnya yang dapat digunakan untuk skenario ini.";
export const UNKNOWN_PARTNER_SENTINEL = "AUTOSNAP-UNKNOWN-CLIENT";

export function clientSimulatorScenario(id: unknown): ScenarioDefinition {
  const found = CLIENT_SIMULATOR_SCENARIOS.find(item => item.id === id);
  if (!found) throw { error: "Skenario pengujian tidak valid. Pilih salah satu dari lima skenario.", status: 400 };
  return found;
}

export function normalizeSnapMessage(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function snapServiceCode(serviceData: Record<string, unknown>): string | null {
  const direct = String(serviceData.serviceCode ?? "").trim();
  if (/^\d{2}$/.test(direct)) return direct;
  const expected = String(serviceData.expectedCode ?? serviceData.expectedSnapCode ?? "").trim();
  if (/^\d{7}$/.test(expected)) return expected.slice(3, 5);
  return null;
}

export function resolveScenarioExpectation(scenario: ScenarioDefinition, serviceData: Record<string, unknown>) {
  const serviceCode = snapServiceCode(serviceData);
  const configuredMessage = String(serviceData.expectedMessage ?? "").trim();
  if (scenario.id === "POSITIVE") {
    const configured = String(serviceData.expectedCode ?? serviceData.expectedSnapCode ?? "").trim();
    if (/^200\d{4}$/.test(configured)) return { expectedHttp: 200, expectedCode: configured, expectedMessage: configuredMessage || null, serviceCode: configured.slice(3, 5), ready: true };
    if (serviceCode) return { expectedHttp: 200, expectedCode: `200${serviceCode}00`, expectedMessage: configuredMessage || null, serviceCode, ready: true };
    return { expectedHttp: 200, expectedCode: null, expectedMessage: null, serviceCode: null, ready: false };
  }
  if (!serviceCode) throw { error: "Kode service SNAP dua digit belum diisi pada API Service. ResponseCode skenario ini tidak ditebak.", status: 400 };
  return { expectedHttp: scenario.expectedHttp, expectedCode: `${scenario.codePrefix}${serviceCode}${scenario.codeSuffix}`, expectedMessage: scenario.expectedMessage, serviceCode, ready: true };
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

export function priorExternalIdFromRuns(rows: { id: string; request: Record<string, unknown> | null }[], scope: { serviceId: string; partnerId: string }) {
  for (const row of rows) {
    const request = row.request;
    if (!request) continue;
    if (request.dispatch !== "SENT" && request.dispatch !== "SEND_STARTED") continue;
    const idempotency = request.idempotency && typeof request.idempotency === "object" && !Array.isArray(request.idempotency) ? request.idempotency as Record<string, unknown> : {};
    if (String(idempotency.serviceId ?? "") !== scope.serviceId) continue;
    if (String(idempotency.partnerId ?? "") !== scope.partnerId) continue;
    const externalId = String(idempotency.externalId ?? "").trim();
    if (!externalId) continue;
    return { externalId, sourceRunId: row.id };
  }
  return null;
}
