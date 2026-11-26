import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function load(name) {
  try { return await import(pathToFileURL(join(root, "backend", "dist", name)).href); }
  catch {
    process.env.TS_NODE_TRANSPILE_ONLY = "1";
    require("ts-node/register/transpile-only");
    return require(join(root, "backend", "src", name.replace(/\.js$/, ".ts")));
  }
}

function message(error) {
  return error && typeof error === "object" && "error" in error ? error.error : error?.message;
}

test("frontend preview matches the backend service name", async () => {
  const { buildClientSimulatorServiceName } = await load("aspi-client-simulator.js");
  const samples = [
    ["Bank SUMUT", "Create VA", "Positive Case"],
    ["Bank SUMUT", "Balance Inquiry", "  Saldo   Tidak   Cukup "],
    ["Bank ABC", "Transfer", "Invalid Signature"],
  ];
  const script = `import { buildClientSimulatorServiceName, clientSimulatorHistoryLabel } from ${JSON.stringify(pathToFileURL(join(root, "app", "client-simulator-name.ts")).href)};
const samples = ${JSON.stringify(samples)};
console.log(JSON.stringify({
  names: samples.map(sample => buildClientSimulatorServiceName(sample[0], sample[1], sample[2])),
  invalid: clientSimulatorHistoryLabel({ scenarioName: "Invalid Signature", testType: "negative" }),
  legacy: clientSimulatorHistoryLabel({ testType: "negative" }),
  positive: clientSimulatorHistoryLabel({ testType: "positive" }),
}));`;
  const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const front = JSON.parse(probe.stdout);
  samples.forEach((sample, index) => assert.equal(front.names[index], buildClientSimulatorServiceName(...sample)));
  assert.equal(front.invalid, "Invalid Signature");
  assert.equal(front.legacy, "Negatif");
  assert.equal(front.positive, "Positif");
});

test("scenario name is rebuilt from database records and does not send a new transaction on evidence identity", async () => {
  process.env.AUTOSNAP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const { encrypt } = await load("security.js");
  const { runClientSimulator } = await load("simulator-run.js");
  const now = new Date().toISOString();
  const provider = {
    id: "prov", kind: "sim_provider", name: "Bank SUMUT", parent_id: null, partner_id: null, created_at: now, updated_at: now,
    data: { baseUrl: "https://dev.banksumut.co.id", clientId: "client-id-1", partnerId: "9296", clientSecret: encrypt("secret"), signatureAccessTokenMode: "NONE", signatureServiceMode: "FUNCTION", hmacEncoding: "base64", channelId: "0001", deviceId: "device-1", timestampConfig: { offsetMinutes: 420, includeMillis: false } },
  };
  const service = {
    id: "svc", kind: "sim_service", name: "Create VA", parent_id: "prov", partner_id: null, created_at: now, updated_at: now,
    data: { method: "POST", path: "/api/v1.0/transfer-va/create-va", defaultBody: "{}", expectedHttpStatus: null, expectedCode: "" },
  };
  const other = { ...service, id: "other", parent_id: "else", name: "Transfer" };
  const user = { id: "snap", kind: "snap_user", name: "QA", parent_id: null, partner_id: null, created_at: now, updated_at: now, data: { email: "qa@example.test", password: encrypt("secret") } };
  const operator = { id: "op", username: "qa", email: "qa@example.test", name: "QA", role: "admin", active: true, privileges: [], created_at: now };
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return sql.includes("autosnap_external_ids") ? [{ external_id: params[1] }] : []; } };
  const submitted = [];
  const gateway = { submit: async (_user, form) => { submitted.push(form); return { httpStatus: 200, response: { responseCode: "2002700" }, responseText: "", activity: null, pdf: null, pdfError: null, steps: [] }; } };

  await assert.rejects(runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap" }, gateway), error => /Skenario pengujian tidak valid/.test(message(error)));
  assert.equal(calls.length, 0);
  await assert.rejects(runClientSimulator(db, [provider, other, user], operator, { providerId: "prov", serviceId: "other", snapUserId: "snap", scenarioName: "Positive Case" }, gateway), error => /tidak milik penyedia/.test(message(error)));

  const result = await runClientSimulator(db, [provider, service, user], operator, {
    providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "POSITIVE", scenarioName: "FORGED", aspiServiceName: "FORGED", serviceName: "FORGED",
    overrides: { expectedHttpStatus: "", expectedCode: "" },
  }, gateway);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].serviceName, "Bank SUMUT - Create VA - Positif");
  assert.equal(result.activityName, "Bank SUMUT - Create VA - Positif");
  assert.equal(result.matched, true);
  const stored = JSON.parse(calls.find(call => call.sql.includes("INSERT INTO autosnap_runs")).params[15]);
  assert.equal(stored.identity.providerName, "Bank SUMUT");
  assert.equal(stored.identity.scenarioName, "Positif");
  assert.equal(stored.scenarioId, "POSITIVE");
  assert.equal(stored.aspiServiceName, "Bank SUMUT - Create VA - Positif");
  provider.name = "Bank ABC";
  assert.equal(stored.identity.providerName, "Bank SUMUT");

  const renamed = await runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "POSITIVE" }, gateway);
  assert.equal(renamed.activityName, "Bank ABC - Create VA - Positif");
  assert.equal(submitted.at(-1).serviceName, renamed.activityName);
  assert.equal(renamed.matched, true, "the words Invalid Signature do not make the run negative");
  assert.equal(submitted.length, 2);
});

test("a crash after Send starts does not submit the transaction again", async () => {
  process.env.AUTOSNAP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const { encrypt } = await load("security.js");
  const { runClientSimulator } = await load("simulator-run.js");
  const now = new Date().toISOString();
  const provider = {
    id: "prov", kind: "sim_provider", name: "Bank SUMUT", parent_id: null, partner_id: null, created_at: now, updated_at: now,
    data: { baseUrl: "https://dev.banksumut.co.id", clientId: "client-id-1", partnerId: "9296", clientSecret: encrypt("secret"), signatureAccessTokenMode: "NONE", signatureServiceMode: "FUNCTION", hmacEncoding: "base64", channelId: "0001", deviceId: "device-1", timestampConfig: { offsetMinutes: 420, includeMillis: false } },
  };
  const service = {
    id: "svc", kind: "sim_service", name: "Create VA", parent_id: "prov", partner_id: null, created_at: now, updated_at: now,
    data: { method: "POST", path: "/api/v1.0/transfer-va/create-va", defaultBody: "{}", expectedHttpStatus: 200, expectedCode: "2002700" },
  };
  const user = { id: "snap", kind: "snap_user", name: "QA", parent_id: null, partner_id: null, created_at: now, updated_at: now, data: { email: "qa@example.test", password: encrypt("secret") } };
  const operator = { id: "op", username: "qa", email: "qa@example.test", name: "QA", role: "admin", active: true, privileges: [], created_at: now };
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return sql.includes("autosnap_external_ids") ? [{ external_id: params[1] }] : []; } };
  let submits = 0;
  const gateway = { submit: async () => { submits += 1; throw Error("browser crashed after send"); } };
  await assert.rejects(runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "POSITIVE" }, gateway), error => message(error) === "browser crashed after send");
  assert.equal(submits, 1);
  const statusUpdate = calls.filter(call => call.sql.includes("UPDATE autosnap_runs SET status")).at(-1);
  assert.equal(statusUpdate.params[0], "UNKNOWN");
});
