import pg from "pg";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (name) => import(pathToFileURL(join(root, "backend", "dist", name)).href);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set search_path to autosnap, public");

const { rows: runs } = await client.query(`
  SELECT id, scenario_id, http_status, response_code,
    request_json->'headers'->>'X-EXTERNAL-ID' AS external_id,
    request_json->'service'->>'path' AS path,
    environment_id, service_id
  FROM autosnap_runs
  WHERE mode='client_sim' AND http_status >= 200 AND http_status < 300
    AND COALESCE(request_json->'headers'->>'X-EXTERNAL-ID','') <> ''
  ORDER BY created_at DESC
  LIMIT 1
`);
if (!runs.length) throw new Error("Tidak ada run sukses dengan X-EXTERNAL-ID.");
const run = runs[0];
const { rows: records } = await client.query(`SELECT id, kind, name, data FROM autosnap_records WHERE id=ANY($1::text[])`, [[run.environment_id, run.service_id]]);
const provider = records.find((r) => r.id === run.environment_id);
const service = records.find((r) => r.id === run.service_id);
if (!provider || !service) throw new Error("Provider/service tidak ditemukan.");

const { decrypt } = await load("security.js");
const { getXSignatureAccessTokenFunction, getXSignatureServiceFunction, ensureFutureTimestamp, minifyJsonBody, joinProviderUrl, normalizeEndpointPath } = await load("simulator-signing.js");

const data = provider.data || {};
const serviceData = service.data || {};
const baseUrl = String(data.baseUrl || "");
const clientKey = String(data.clientKey || data.clientId || "");
const partnerId = String(serviceData.partnerId || data.partnerId || clientKey);
const channelId = String(serviceData.channelId || data.channelId || "");
const deviceId = String(serviceData.deviceId || data.deviceId || "");
const relative = String(serviceData.path || serviceData.serviceUrl || "");
const method = String(serviceData.method || "POST").toUpperCase();
const bodyText = typeof serviceData.defaultBody === "string" ? serviceData.defaultBody : "{}";
const signedBody = method === "GET" || method === "HEAD" ? "" : minifyJsonBody(bodyText || "{}");
const serviceUrl = joinProviderUrl(baseUrl, relative);
const externalId = run.external_id;
const tsConfig = data.timestampConfig && typeof data.timestampConfig === "object" ? data.timestampConfig : { offsetMinutes: 420, includeMillis: false };

const privateKey = decrypt(String(data.privateKey || ""));
const clientSecret = decrypt(String(data.clientSecret || ""));
const tokenPath = normalizeEndpointPath(String(data.accessTokenUrl || "/api/v1.0/access-token/b2b"), baseUrl);
const tokenUrl = joinProviderUrl(baseUrl, tokenPath);

async function hit(label) {
  const timestamp = ensureFutureTimestamp(tsConfig, undefined, "positive");
  const authSig = getXSignatureAccessTokenFunction(privateKey, clientKey, timestamp, data.rsaEncoding === "hex" ? "hex" : "base64");
  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TIMESTAMP": timestamp, "X-CLIENT-KEY": clientKey, "X-SIGNATURE": authSig },
    body: JSON.stringify({ grantType: "client_credentials", additionalInfo: {} }),
  });
  const tokenJson = await tokenRes.json();
  const accessToken = String(tokenJson.accessToken || tokenJson.access_token || "");
  if (!accessToken) throw new Error(`${label}: access token gagal ${tokenRes.status} ${JSON.stringify(tokenJson)}`);
  const svcTimestamp = ensureFutureTimestamp(tsConfig, undefined, "positive", new Date(Date.now() + 5000));
  const signature = getXSignatureServiceFunction(clientSecret, method, relative, accessToken, signedBody, svcTimestamp, data.hmacEncoding === "hex" ? "hex" : "base64");
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
  console.log(JSON.stringify({ label, externalId, http: response.status, body: json }, null, 2));
  return { http: response.status, body: json };
}

console.log(JSON.stringify({ usingRun: run.id, scenario: run.scenario_id, externalId, serviceUrl, relative }, null, 2));
const first = await hit("hit-1");
await new Promise((r) => setTimeout(r, 1500));
const second = await hit("hit-2");
console.log(JSON.stringify({
  verdict: second.http === 409 || String(second.body?.responseCode || "").startsWith("409")
    ? "BANK_REJECTS_DUPLICATE_EXTERNAL_ID"
    : "BANK_ACCEPTS_DUPLICATE_EXTERNAL_ID",
  firstHttp: first.http,
  firstCode: first.body?.responseCode,
  secondHttp: second.http,
  secondCode: second.body?.responseCode,
  secondMessage: second.body?.responseMessage,
}, null, 2));
await client.end();
