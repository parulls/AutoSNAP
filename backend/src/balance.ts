import { isIP } from "node:net";

export const BALANCE_PATH = "/api/v1.0/balance-inquiry";
export type UseCase = "B2B" | "B2B2C";
export type Check = { label: string; passed: boolean; detail: string };
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function validateBalanceRequest(body: Record<string, unknown>, hasCustomerToken: boolean): string[] {
  const errors: string[] = [];
  for (const [field, max] of [["partnerReferenceNo", 64], ["accountNo", 16], ["bankCardToken", 128]] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== "string" || value.length > max)) errors.push(`${field} harus string maksimal ${max} karakter.`);
  }
  if (!(typeof body.accountNo === "string" && body.accountNo.trim()) && !(typeof body.bankCardToken === "string" && body.bankCardToken.trim()) && !hasCustomerToken) errors.push("Isi accountNo atau bankCardToken dari Registrasi; customer token dapat menjadi identitas pada B2B2C.");
  if (body.balanceTypes !== undefined && (!Array.isArray(body.balanceTypes) || body.balanceTypes.some(x => typeof x !== "string"))) errors.push("balanceTypes harus array string; hilangkan field untuk semua jenis saldo.");
  if (body.additionalInfo !== undefined && !object(body.additionalInfo)) errors.push("additionalInfo harus object JSON.");
  return errors;
}

export function validateHeaderProfile(data: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of ["origin", "ipAddress", "latitude", "longitude", "deviceId", "channelId"]) {
    if (data[field] !== undefined && (typeof data[field] !== "string" || /[\r\n]/.test(String(data[field])))) errors.push(`${field} harus teks tanpa baris baru.`);
  }
  if (data.ipAddress && isIP(String(data.ipAddress)) !== 4) errors.push("X-IP-ADDRESS harus alamat IPv4 valid, bukan contoh 172.24.281.24.");
  for (const [field, min, max] of [["latitude", -90, 90], ["longitude", -180, 180]] as const) {
    if (data[field] && (!Number.isFinite(Number(data[field])) || Number(data[field]) < min || Number(data[field]) > max)) errors.push(`${field} harus antara ${min} dan ${max}.`);
  }
  return errors;
}

export function balanceResponseChecks(status: number, response: unknown, expected: string, request: Record<string, unknown>): Check[] {
  const body = object(response) ? response : {};
  const checks: Check[] = [];
  const add = (label: string, passed: boolean, detail: string) => checks.push({ label, passed, detail });
  add("HTTP status", status === Number(expected.slice(0, 3)), `Expected ${expected.slice(0, 3)}, received ${status}.`);
  add("SNAP responseCode", body.responseCode === expected, `Expected ${expected}, received ${String(body.responseCode ?? "missing")}.`);
  add("Response JSON", object(response), "Response harus berupa object JSON.");
  add("responseMessage", typeof body.responseMessage === "string" && body.responseMessage.length > 0 && body.responseMessage.length <= 150, "Wajib string, maksimal 150 karakter.");
  if (body.responseCode !== "2001100") return checks;
  if (body.partnerReferenceNo !== undefined && request.partnerReferenceNo !== undefined) add("partnerReferenceNo", body.partnerReferenceNo === request.partnerReferenceNo, "Referensi response harus sama dengan request.");
  if (body.accountInfos !== undefined) {
    add("accountInfos", Array.isArray(body.accountInfos), "Jika ada, accountInfos harus array.");
    if (Array.isArray(body.accountInfos)) body.accountInfos.forEach((entry, index) => {
      add(`accountInfos[${index}]`, object(entry), "Setiap entri harus object.");
      if (!object(entry)) return;
      for (const field of ["amount", "floatAmount", "holdAmount", "availableBalance", "ledgerBalance", "currentMultilateralLimit"]) {
        if (entry[field] === undefined) continue;
        const money = entry[field];
        add(`accountInfos[${index}].${field}`, object(money) && typeof money.value === "string" && /^-?\d{1,16}\.\d{2}$/.test(money.value) && typeof money.currency === "string" && /^[A-Z]{3}$/.test(money.currency), "Object nominal memerlukan value desimal 2 digit dan currency 3 huruf.");
      }
      if (entry.status !== undefined) add(`accountInfos[${index}].status`, ["0001", "0002", "0004", "0006", "0007", "0009"].includes(String(entry.status)), "Status rekening harus sesuai enum SNAP.");
    });
  }
  return checks;
}

export function mockBalance(body: Record<string, unknown>, code: string) {
  if (code !== "2001100") return { responseCode: code, responseMessage: "Simulated error", additionalInfo: { mock: true } };
  const types = Array.isArray(body.balanceTypes) && body.balanceTypes.length ? body.balanceTypes : ["Cash", "Coins"];
  return {
    responseCode: code, responseMessage: "Successful", referenceNo: `MOCK-${Date.now()}`,
    ...(body.partnerReferenceNo ? { partnerReferenceNo: body.partnerReferenceNo } : {}),
    ...(body.accountNo ? { accountNo: body.accountNo } : {}), name: "REKENING SIMULASI",
    accountInfos: types.map(balanceType => ({ balanceType, amount: { value: "1000000.00", currency: "IDR" }, availableBalance: { value: "1000000.00", currency: "IDR" }, status: "0001" })),
    additionalInfo: { mock: true },
  };
}
