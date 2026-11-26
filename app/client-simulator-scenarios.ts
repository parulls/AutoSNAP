/** Mirrors backend/src/client-simulator-scenarios.ts for the Client Simulator form. The backend recomputes the scenario on every run. */
export const CLIENT_SIMULATOR_SCENARIOS = [
  { id: "CUSTOM", label: "Lainnya", expectedHttp: null as number | null, codePrefix: null as string | null, codeSuffix: null as string | null, expectedMessage: null as string | null, summary: "Konfigurasi manual: method, path, body, header, dan expected response diisi operator. Access Token dan signature tetap dikelola backend." },
  { id: "INVALID_ACCESS_TOKEN", label: "Access Token Invalid", expectedHttp: 401, codePrefix: "401", codeSuffix: "01", expectedMessage: "Access Token Invalid", summary: "Signature Service tetap memakai Access Token valid. Token invalid hanya dipakai pada request API Service lewat Client Simulator ASPI." },
  { id: "INVALID_SIGNATURE", label: "Unauthorized . Signature", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Signature", summary: "X-SIGNATURE pada request API Service berbeda dari signature yang valid. Access Token dan Partner ID tetap valid." },
  { id: "UNKNOWN_CLIENT", label: "Unauthorized . Unknown Client", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Client", summary: "X-PARTNER-ID pada request API Service diganti identitas yang tidak dikenal. Access Token dan signature tetap valid." },
  { id: "DUPLICATE_EXTERNAL_ID", label: "Cannot use the same X-EXTERNAL-ID", expectedHttp: 409, codePrefix: "409", codeSuffix: "00", expectedMessage: "Conflict", summary: "AutoSNAP membuat X-EXTERNAL-ID baru, mengunci ke bank dengan satu request baseline langsung (bukan ASPI), lalu mengirim ID yang sama lewat Client Simulator ASPI. Hasil pengujian adalah respons ASPI." },
] as const;

export type ClientSimulatorScenarioId = (typeof CLIENT_SIMULATOR_SCENARIOS)[number]["id"];

export function clientSimulatorScenario(id: string) {
  return CLIENT_SIMULATOR_SCENARIOS.find((item) => item.id === id) ?? null;
}

export function presentScenarioExpectation(
  id: string,
  data: Record<string, unknown>,
  custom?: { expectedHttpStatus?: string; expectedCode?: string; expectedMessage?: string } | null,
) {
  const scenario = clientSimulatorScenario(id);
  if (!scenario) return null;
  if (scenario.id === "CUSTOM") {
    const http = Number(custom?.expectedHttpStatus ?? data.expectedHttpStatus ?? "");
    const code = String(custom?.expectedCode ?? data.expectedCode ?? data.expectedSnapCode ?? "").trim();
    const message = String(custom?.expectedMessage ?? data.expectedMessage ?? "").trim();
    return {
      http: Number.isInteger(http) && http >= 100 && http <= 599 ? http : null,
      code: /^\d{7}$/.test(code) ? code : null,
      pattern: "custom",
      message: message || "—",
      ready: Number.isInteger(http) && http >= 100 && http <= 599,
      summary: scenario.summary,
    };
  }
  const pattern = `${scenario.codePrefix}xx${scenario.codeSuffix}`;
  const configured = String(data.expectedCode ?? data.expectedSnapCode ?? "").trim();
  const configuredMessage = String(data.expectedMessage ?? "").trim();
  const code = /^\d{7}$/.test(configured) && scenario.codePrefix && scenario.codeSuffix && configured.startsWith(scenario.codePrefix) && configured.endsWith(scenario.codeSuffix) ? configured : null;
  return { http: scenario.expectedHttp, code, pattern, message: scenario.expectedMessage || configuredMessage || "—", ready: true, summary: scenario.summary };
}
