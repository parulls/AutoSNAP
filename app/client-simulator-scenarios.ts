/** Mirrors backend/src/client-simulator-scenarios.ts for the Client Simulator form. The backend recomputes the scenario on every run. */
export const CLIENT_SIMULATOR_SCENARIOS = [
  { id: "POSITIVE", label: "Positif", expectedHttp: 200, codePrefix: "200", codeSuffix: "00", expectedMessage: null, summary: "Request memakai Access Token, signature, Partner ID, dan X-EXTERNAL-ID yang valid." },
  { id: "INVALID_ACCESS_TOKEN", label: "Access Token Invalid", expectedHttp: 401, codePrefix: "401", codeSuffix: "01", expectedMessage: "Access Token Invalid", summary: "Signature Service tetap memakai Access Token valid. Token invalid hanya dipakai pada request API Service lewat Client Simulator ASPI." },
  { id: "INVALID_SIGNATURE", label: "Unauthorized . Signature", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Signature", summary: "X-SIGNATURE pada request API Service berbeda dari signature yang valid. Access Token dan Partner ID tetap valid." },
  { id: "UNKNOWN_CLIENT", label: "Unauthorized . Unknown Client", expectedHttp: 401, codePrefix: "401", codeSuffix: "00", expectedMessage: "Unauthorized Client", summary: "X-PARTNER-ID pada request API Service diganti identitas yang tidak dikenal. Access Token dan signature tetap valid." },
  { id: "DUPLICATE_EXTERNAL_ID", label: "Cannot use the same X-EXTERNAL-ID", expectedHttp: 409, codePrefix: "409", codeSuffix: "01", expectedMessage: "Conflict", summary: "X-EXTERNAL-ID diambil dari pengujian sebelumnya yang sudah terkirim. Access Token dan signature tetap valid." },
] as const;

export type ClientSimulatorScenarioId = (typeof CLIENT_SIMULATOR_SCENARIOS)[number]["id"];

export function clientSimulatorScenario(id: string) {
  return CLIENT_SIMULATOR_SCENARIOS.find(item => item.id === id) ?? null;
}

export function presentScenarioExpectation(id: string, data: Record<string, unknown>) {
  const scenario = clientSimulatorScenario(id);
  if (!scenario) return null;
  const pattern = `${scenario.codePrefix}xx${scenario.codeSuffix}`;
  const configured = String(data.expectedCode ?? data.expectedSnapCode ?? "").trim();
  const configuredMessage = String(data.expectedMessage ?? "").trim();
  if (scenario.id === "POSITIVE") {
    const code = /^\d{7}$/.test(configured) && configured.startsWith("200") ? configured : null;
    return { http: 200, code, pattern, message: configuredMessage || "—", ready: true, summary: scenario.summary };
  }
  const code = /^\d{7}$/.test(configured) && configured.startsWith(scenario.codePrefix) && configured.endsWith(scenario.codeSuffix) ? configured : null;
  return { http: scenario.expectedHttp, code, pattern, message: scenario.expectedMessage, ready: true, summary: scenario.summary };
}
