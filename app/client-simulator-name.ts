/** Mirrors backend/src/aspi-client-simulator.ts. The backend recomputes the name from the database on every run. */
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

export function buildClientSimulatorServiceName(providerName: string, serviceName: string, scenarioName: string) {
  const provider = normalizeClientSimulatorComponent(providerName, "Nama penyedia");
  const service = normalizeClientSimulatorComponent(serviceName, "Nama service");
  const scenario = normalizeClientSimulatorComponent(scenarioName, "Nama Skenario");
  const combined = `${provider} - ${service} - ${scenario}`;
  if (combined.length > ASPI_SERVICE_NAME_MAX) throw { error: `Service Name ASPI maksimal ${ASPI_SERVICE_NAME_MAX} karakter. Perkecil Nama Skenario.`, status: 400 };
  return combined;
}

export function clientSimulatorHistoryLabel(request: { scenarioName?: unknown; testType?: unknown }) {
  const scenario = typeof request.scenarioName === "string" ? request.scenarioName.trim() : "";
  if (scenario) return scenario;
  const testType = String(request.testType ?? "");
  if (testType === "negative" || testType === "invalid_access_token") return "Negatif";
  if (testType) return "Positif";
  return "—";
}

export function thrownMessage(error: unknown) {
  return error && typeof error === "object" && "error" in error ? String((error as { error: unknown }).error) : "Service Name ASPI belum lengkap.";
}
