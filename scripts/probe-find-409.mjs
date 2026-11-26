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
const partnerId = String(serviceData.partnerId || data.partnerId || clientKey);
const channelId = String(serviceData.channelId || data.channelId || "0001");
const deviceId = String(serviceData.deviceId || data.deviceId || "");
const privateKey = decrypt(String(data.privateKey || ""));
const clientSecret = decrypt(String(data.clientSecret || ""));
const hmacEncoding = data.hmacEncoding === "hex" ? "hex" : "base64";
const tsConfig = data.timestampConfig && typeof data.timestampConfig === "object" ? data.timestampConfig : { offsetMinutes: 420, includeMillis: false };
const tokenUrl = joinProviderUrl(baseUrl, normalizeEndpointPath(String(data.accessTokenUrl || "/api/v1.0/access-token/b2b"), baseUrl));
const baseBody = JSON.parse(typeof serviceData.defaultBody === "string" ? serviceData.defaultBody : "{}");

async function tokenAndSign(relative, bodyText) {
  const timestamp = ensureFutureTimestamp(tsConfig, undefined, "positive");
  const authSig = getXSignatureAccessTokenFunction(privateKey, clientKey, timestamp, "base64");
  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TIMESTAMP": timestamp, "X-CLIENT-KEY": clientKey, "X-SIGNATURE": authSig },
    body: JSON.stringify({ grantType: "client_credentials", additionalInfo: {} }),
  });
  const tokenJson = await tokenRes.json();
  const accessToken = String(tokenJson.accessToken || tokenJson.access_token || "");
  const svcTimestamp = ensureFutureTimestamp(tsConfig, undefined, "positive", new Date(Date.now() + 2000));
  const signature = getXSignatureServiceFunction(clientSecret, "POST", relative, accessToken, bodyText, svcTimestamp, hmacEncoding);
  return { accessToken, svcTimestamp, signature, bodyText };
}

async function send(relative, externalId, bodyObj, label) {
  const bodyText = minifyJsonBody(JSON.stringify(bodyObj));
  const signed = await tokenAndSign(relative, bodyText);
  const headers = {
    "Content-Type": "application/json",
    "X-TIMESTAMP": signed.svcTimestamp,
    "X-PARTNER-ID": partnerId,
    "X-EXTERNAL-ID": externalId,
    "X-SIGNATURE": signed.signature,
    "CHANNEL-ID": channelId,
    Authorization: `Bearer ${signed.accessToken}`,
  };
  if (deviceId) headers["X-DEVICE-ID"] = deviceId;
  const url = joinProviderUrl(baseUrl, relative);
  const response = await fetch(url, { method: "POST", headers, body: bodyText });
  const json = await response.json().catch(async () => ({ raw: await response.text() }));
  console.log(JSON.stringify({ label, relative, externalId, hasTrxId: Object.prototype.hasOwnProperty.call(bodyObj, "trxId"), trxId: bodyObj.trxId || null, http: response.status, code: json.responseCode, message: json.responseMessage }, null, 2));
  return { http: response.status, json };
}

const paths = [
  "/api/v1.0.0/transfer-va/create-vagov",
  "/api/v1.0/transfer-va/create-vagov",
  "/api/v1.0.0/transfer-va/create-va",
  "/api/v1.0/transfer-va/create-va",
];
const externalId = "12345678";
const fixedTrx = `TRX-FIXED-${Date.now()}`;

for (const relative of paths) {
  console.log(`\n===== PATH ${relative} / same body no trxId =====`);
  try {
    await send(relative, externalId, { ...baseBody }, "hit-1");
    await new Promise((r) => setTimeout(r, 800));
    await send(relative, externalId, { ...baseBody }, "hit-2-same-ext-no-trx");
  } catch (e) {
    console.log(JSON.stringify({ relative, error: e.message }));
  }

  console.log(`\n===== PATH ${relative} / same body WITH fixed trxId ${fixedTrx} =====`);
  try {
    const body = { ...baseBody, trxId: fixedTrx };
    await send(relative, `88${Date.now().toString().slice(-6)}`, body, "hit-1-new-ext-fixed-trx");
    await new Promise((r) => setTimeout(r, 800));
    await send(relative, `88${Date.now().toString().slice(-6)}`, body, "hit-2-new-ext-same-trx");
  } catch (e) {
    console.log(JSON.stringify({ relative, error: e.message }));
  }

  console.log(`\n===== PATH ${relative} / same externalId AND same trxId =====`);
  try {
    const ext = `77${Date.now().toString().slice(-6)}`;
    const trx = `SAME-${Date.now()}`;
    const body = { ...baseBody, trxId: trx };
    await send(relative, ext, body, "hit-1-same-both");
    await new Promise((r) => setTimeout(r, 800));
    await send(relative, ext, body, "hit-2-same-both");
  } catch (e) {
    console.log(JSON.stringify({ relative, error: e.message }));
  }
}

await client.end();
