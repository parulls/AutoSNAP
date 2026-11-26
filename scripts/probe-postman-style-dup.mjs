import pg from "pg";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (name) => import(pathToFileURL(join(root, "backend", "dist", name)).href);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set search_path to autosnap, public");
const { rows: records } = await client.query(`
  SELECT id, kind, name, data
  FROM autosnap_records
  WHERE kind IN ('sim_provider','sim_service')
  ORDER BY kind, updated_at DESC NULLS LAST, name
`);
const provider = records.find((r) => r.kind === "sim_provider");
const service = records.find((r) => r.kind === "sim_service" && r.parent_id === provider?.id) || records.find((r) => r.kind === "sim_service");
if (!provider || !service) throw new Error("provider/service missing");

const { decrypt } = await load("security.js");
const {
  getXSignatureAccessTokenFunction,
  getXSignatureServiceFunction,
  ensureFutureTimestamp,
  minifyJsonBody,
  joinProviderUrl,
  normalizeEndpointPath,
} = await load("simulator-signing.js");

const data = provider.data || {};
const serviceData = service.data || {};
console.log(JSON.stringify({
  provider: provider.name,
  service: service.name,
  baseUrl: data.baseUrl,
  path: serviceData.path || serviceData.serviceUrl,
  method: serviceData.method,
  partnerId: serviceData.partnerId || data.partnerId,
  channelId: serviceData.channelId || data.channelId,
  hmacEncoding: data.hmacEncoding,
  signatureServiceMode: data.signatureServiceMode,
  body: serviceData.defaultBody || serviceData.requestBody,
}, null, 2));

const baseUrl = String(data.baseUrl || "");
const clientKey = String(data.clientKey || data.clientId || "");
const partnerId = String(serviceData.partnerId || data.partnerId || clientKey);
const channelId = String(serviceData.channelId || data.channelId || "");
const deviceId = String(serviceData.deviceId || data.deviceId || "");
const relative = String(serviceData.path || serviceData.serviceUrl || "");
const method = String(serviceData.method || "POST").toUpperCase();
const bodyText = typeof serviceData.defaultBody === "string" ? serviceData.defaultBody : typeof serviceData.requestBody === "string" ? serviceData.requestBody : "{}";
const signedBody = method === "GET" || method === "HEAD" ? "" : minifyJsonBody(bodyText || "{}");
const serviceUrl = joinProviderUrl(baseUrl, relative);
const privateKey = decrypt(String(data.privateKey || ""));
const clientSecret = decrypt(String(data.clientSecret || ""));
const hmacEncoding = data.hmacEncoding === "hex" ? "hex" : "base64";
const tokenPath = normalizeEndpointPath(String(data.accessTokenUrl || "/api/v1.0/access-token/b2b"), baseUrl);
const tokenUrl = joinProviderUrl(baseUrl, tokenPath);
const tsConfig = data.timestampConfig && typeof data.timestampConfig === "object" ? data.timestampConfig : { offsetMinutes: 420, includeMillis: false };

async function hit(externalId, label) {
  const timestamp = ensureFutureTimestamp(tsConfig, undefined, "positive");
  const authSig = getXSignatureAccessTokenFunction(privateKey, clientKey, timestamp, data.rsaEncoding === "hex" ? "hex" : "base64");
  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TIMESTAMP": timestamp, "X-CLIENT-KEY": clientKey, "X-SIGNATURE": authSig },
    body: JSON.stringify({ grantType: "client_credentials", additionalInfo: {} }),
  });
  const tokenJson = await tokenRes.json();
  const accessToken = String(tokenJson.accessToken || tokenJson.access_token || "");
  if (!accessToken) throw new Error(`${label}: token fail ${tokenRes.status} ${JSON.stringify(tokenJson)}`);
  const svcTimestamp = ensureFutureTimestamp(tsConfig, undefined, "positive", new Date(Date.now() + 2000));
  const signature = getXSignatureServiceFunction(clientSecret, method, relative, accessToken, signedBody, svcTimestamp, hmacEncoding);
  const headers = {
    "Content-Type": "application/json",
    "X-TIMESTAMP": svcTimestamp,
    "X-PARTNER-ID": partnerId,
    "X-EXTERNAL-ID": externalId,
    "X-SIGNATURE": signature,
    "CHANNEL-ID": channelId,
    Authorization: `Bearer ${accessToken}`,
  };
  if (deviceId) headers["X-DEVICE-ID"] = deviceId;
  const response = await fetch(serviceUrl, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : signedBody });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  console.log(JSON.stringify({ label, externalId, relative, hmacEncoding, http: response.status, code: json?.responseCode, message: json?.responseMessage, trxId: json?.virtualAccountData?.trxId }, null, 2));
  return { http: response.status, json };
}

for (const externalId of ["12345678", `9${Date.now().toString().slice(-7)}`]) {
  console.log("\n=== probe", externalId, "===");
  const a = await hit(externalId, "hit-1");
  await new Promise((r) => setTimeout(r, 1200));
  const b = await hit(externalId, "hit-2");
  console.log(JSON.stringify({
    externalId,
    result: b.http === 409 || String(b.json?.responseCode || "").startsWith("409") ? "GOT_409" : "STILL_200",
    first: { http: a.http, code: a.json?.responseCode },
    second: { http: b.http, code: b.json?.responseCode, message: b.json?.responseMessage },
  }, null, 2));
}

await client.end();
