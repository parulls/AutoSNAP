import pg from "pg";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (name) => import(pathToFileURL(join(root, "backend", "dist", name)).href);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set search_path to autosnap, public");
const provider = (await client.query(`SELECT data FROM autosnap_records WHERE kind='sim_provider' LIMIT 1`)).rows[0].data;
const service = (await client.query(`SELECT data FROM autosnap_records WHERE kind='sim_service' LIMIT 1`)).rows[0].data;
const { decrypt } = await load("security.js");
const { getXSignatureAccessTokenFunction, getXSignatureServiceFunction, ensureFutureTimestamp, minifyJsonBody, joinProviderUrl, normalizeEndpointPath } = await load("simulator-signing.js");
const baseUrl = String(provider.baseUrl || "");
const clientKey = String(provider.clientKey || provider.clientId || "");
const privateKey = decrypt(String(provider.privateKey || ""));
const clientSecret = decrypt(String(provider.clientSecret || ""));
const relative = "/api/v1.0.0/transfer-va/create-vagov";
const bodyText = minifyJsonBody(typeof service.defaultBody === "string" ? service.defaultBody : "{}");
const deviceId = String(service.deviceId || provider.deviceId || "h2hBatubara");
const tokenUrl = joinProviderUrl(baseUrl, normalizeEndpointPath(String(provider.accessTokenUrl || "/api/v1.0/access-token/b2b"), baseUrl));
const tsConfig = { offsetMinutes: 420, includeMillis: false };

async function pair(partnerId, channelId, externalId) {
  async function hit(label) {
    const timestamp = ensureFutureTimestamp(tsConfig, undefined, "positive");
    const authSig = getXSignatureAccessTokenFunction(privateKey, clientKey, timestamp, "base64");
    const tokenRes = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-TIMESTAMP": timestamp, "X-CLIENT-KEY": clientKey, "X-SIGNATURE": authSig }, body: JSON.stringify({ grantType: "client_credentials", additionalInfo: {} }) });
    const tokenJson = await tokenRes.json();
    const accessToken = String(tokenJson.accessToken || "");
    const svcTimestamp = ensureFutureTimestamp(tsConfig, undefined, "positive", new Date(Date.now() + 2000));
    const signature = getXSignatureServiceFunction(clientSecret, "POST", relative, accessToken, bodyText, svcTimestamp, "base64");
    const headers = { "Content-Type": "application/json", "X-TIMESTAMP": svcTimestamp, "X-PARTNER-ID": partnerId, "X-EXTERNAL-ID": externalId, "X-SIGNATURE": signature, "CHANNEL-ID": channelId, Authorization: `Bearer ${accessToken}`, "X-DEVICE-ID": deviceId };
    const response = await fetch(joinProviderUrl(baseUrl, relative), { method: "POST", headers, body: bodyText });
    const json = await response.json();
    console.log(JSON.stringify({ label, partner: partnerId.slice(0, 10), channelId, externalId, http: response.status, code: json.responseCode, message: json.responseMessage }, null, 2));
  }
  await hit("1");
  await new Promise((r) => setTimeout(r, 1000));
  await hit("2");
}

const ext = `${Date.now()}42`.slice(0, 36);
console.log("clientKey partner + channel 0001");
await pair(clientKey, "0001", ext);
const ext2 = `${Date.now()}43`.slice(0, 36);
console.log("clientKey partner + channel 9975");
await pair(clientKey, "9975", ext2);
await client.end();
