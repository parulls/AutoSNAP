import pg from "pg";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (name) => import(pathToFileURL(join(root, "backend", "dist", name)).href);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set search_path to autosnap, public");
const { rows } = await client.query(`SELECT id, kind, name, data FROM autosnap_records WHERE kind IN ('sim_provider','sim_service')`);
const provider = rows.find((r) => r.kind === "sim_provider");
const service = rows.find((r) => r.kind === "sim_service");
const { decrypt } = await load("security.js");
const { getXSignatureAccessTokenFunction, getXSignatureServiceFunction, ensureFutureTimestamp, minifyJsonBody, joinProviderUrl, normalizeEndpointPath } = await load("simulator-signing.js");
const data = provider.data;
const serviceData = service.data;
const baseUrl = String(data.baseUrl || "");
const clientKey = String(data.clientKey || data.clientId || "");
const channelId = String(serviceData.channelId || data.channelId || "0001");
const deviceId = String(serviceData.deviceId || data.deviceId || "");
const privateKey = decrypt(String(data.privateKey || ""));
const clientSecret = decrypt(String(data.clientSecret || ""));
const relative = "/api/v1.0.0/transfer-va/create-vagov";
const bodyObj = JSON.parse(serviceData.defaultBody || "{}");
const bodyText = minifyJsonBody(JSON.stringify(bodyObj));
const tokenUrl = joinProviderUrl(baseUrl, normalizeEndpointPath(String(data.accessTokenUrl || "/api/v1.0/access-token/b2b"), baseUrl));
const tsConfig = { offsetMinutes: 420, includeMillis: false };
const partners = [
  String(serviceData.partnerId || data.partnerId || clientKey),
  String(bodyObj.additionalInfo?.clientid || ""),
  String(bodyObj.partnerServiceId || ""),
  clientKey,
].filter((v, i, arr) => v && arr.indexOf(v) === i);

console.log(JSON.stringify({ baseUrl, relative, clientKeyPrefix: clientKey.slice(0, 6), partners, bodyKeys: Object.keys(bodyObj) }, null, 2));

async function hit(partnerId, externalId, label) {
  const timestamp = ensureFutureTimestamp(tsConfig, undefined, "positive");
  const authSig = getXSignatureAccessTokenFunction(privateKey, clientKey, timestamp, "base64");
  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TIMESTAMP": timestamp, "X-CLIENT-KEY": clientKey, "X-SIGNATURE": authSig },
    body: JSON.stringify({ grantType: "client_credentials", additionalInfo: {} }),
  });
  const tokenJson = await tokenRes.json();
  const accessToken = String(tokenJson.accessToken || "");
  const svcTimestamp = ensureFutureTimestamp(tsConfig, undefined, "positive", new Date(Date.now() + 2000));
  const signature = getXSignatureServiceFunction(clientSecret, "POST", relative, accessToken, bodyText, svcTimestamp, "base64");
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
  const response = await fetch(joinProviderUrl(baseUrl, relative), { method: "POST", headers, body: bodyText });
  const json = await response.json();
  console.log(JSON.stringify({ label, partnerId: partnerId.slice(0, 12), externalId, http: response.status, code: json.responseCode, message: json.responseMessage }, null, 2));
  return json;
}

for (const partnerId of partners) {
  const ext = "12345678";
  console.log("\n=== partner", partnerId.slice(0, 12), "ext", ext, "===");
  await hit(partnerId, ext, "1");
  await new Promise((r) => setTimeout(r, 1000));
  await hit(partnerId, ext, "2");
}
await client.end();
