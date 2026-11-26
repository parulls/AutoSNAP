import pg from "pg";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (name) => import(pathToFileURL(join(root, "backend", "dist", name)).href);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set search_path to autosnap, public");
const { rows } = await client.query(`SELECT data FROM autosnap_records WHERE kind='sim_provider' LIMIT 1`);
const service = (await client.query(`SELECT data FROM autosnap_records WHERE kind='sim_service' LIMIT 1`)).rows[0];
const { decrypt } = await load("security.js");
const { getXSignatureAccessTokenFunction, getXSignatureServiceFunction, ensureFutureTimestamp, minifyJsonBody, joinProviderUrl, normalizeEndpointPath } = await load("simulator-signing.js");
const data = rows[0].data;
const serviceData = service.data;
const baseUrl = String(data.baseUrl || "");
const clientKey = String(data.clientKey || data.clientId || "");
const channelId = String(serviceData.channelId || data.channelId || "0001");
const deviceId = String(serviceData.deviceId || data.deviceId || "");
const privateKey = decrypt(String(data.privateKey || ""));
const clientSecret = decrypt(String(data.clientSecret || ""));
const relative = "/api/v1.0.0/transfer-va/create-vagov";
const bodyText = minifyJsonBody(typeof serviceData.defaultBody === "string" ? serviceData.defaultBody : "{}");
const tokenUrl = joinProviderUrl(baseUrl, normalizeEndpointPath(String(data.accessTokenUrl || "/api/v1.0/access-token/b2b"), baseUrl));
const tsConfig = { offsetMinutes: 420, includeMillis: false };

async function runPair(partnerId, externalId) {
  async function hit(label) {
    const timestamp = ensureFutureTimestamp(tsConfig, undefined, "positive");
    const authSig = getXSignatureAccessTokenFunction(privateKey, clientKey, timestamp, "base64");
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TIMESTAMP": timestamp, "X-CLIENT-KEY": clientKey, "X-SIGNATURE": authSig },
      body: JSON.stringify({ grantType: "client_credentials", additionalInfo: {} }),
    });
    const tokenJson = await tokenRes.json();
    const accessToken = String(tokenJson.accessToken || tokenJson.access_token || "");
    console.log(JSON.stringify({ label: label + "-token", tokenHttp: tokenRes.status, tokenCode: tokenJson.responseCode, tokenLen: accessToken.length }, null, 2));
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
    console.log(JSON.stringify({ label, partnerId, externalId, http: response.status, code: json.responseCode, message: json.responseMessage }, null, 2));
  }
  await hit("1");
  await new Promise((r) => setTimeout(r, 1200));
  await hit("2");
}

const bodyClientId = JSON.parse(serviceData.defaultBody || "{}").additionalInfo?.clientid || "";
console.log(JSON.stringify({ clientKey, bodyClientId }, null, 2));
const fresh = `${Date.now()}000001`.slice(0, 36);
await runPair(bodyClientId, fresh);
await client.end();
