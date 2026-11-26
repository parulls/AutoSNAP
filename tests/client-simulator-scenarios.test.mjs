import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function load(name) {
  return import(pathToFileURL(join(root, "backend", "dist", name)).href);
}

function message(error) {
  return error && typeof error === "object" && "error" in error ? error.error : error?.message;
}

test("five scenarios use optional SNAP codes and isolate one request field", async () => {
  const scenarios = await load("client-simulator-scenarios.js");
  const { evaluateTest, finalOutcome } = await load("test-evaluation.js");
  assert.deepEqual(scenarios.CLIENT_SIMULATOR_SCENARIOS.map(item => item.label), ["Positif", "Access Token Invalid", "Unauthorized . Signature", "Unauthorized . Unknown Client", "Cannot use the same X-EXTERNAL-ID"]);
  assert.throws(() => scenarios.clientSimulatorScenario("SALDO"), error => message(error).includes("tidak valid"));
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("POSITIVE"), {}).expectedHttp, 200);
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("POSITIVE"), {}).expectedCode, null);
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("POSITIVE"), { expectedCode: "2002700" }).expectedCode, "2002700");
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("INVALID_ACCESS_TOKEN"), {}).expectedHttp, 401);
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("INVALID_ACCESS_TOKEN"), {}).expectedCode, null);
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("INVALID_ACCESS_TOKEN"), { expectedCode: "4012701" }).expectedCode, "4012701");
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("INVALID_SIGNATURE"), {}).expectedMessage, "Unauthorized Signature");
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("UNKNOWN_CLIENT"), {}).expectedMessage, "Unauthorized Client");
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("DUPLICATE_EXTERNAL_ID"), {}).expectedHttp, 409);
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("DUPLICATE_EXTERNAL_ID"), {}).expectedMessage, "Conflict");
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("DUPLICATE_EXTERNAL_ID"), { serviceCode: "27" }).expectedCode, "4092700");
  assert.equal(scenarios.resolveScenarioExpectation(scenarios.clientSimulatorScenario("DUPLICATE_EXTERNAL_ID"), { expectedCode: "4092700" }).expectedCode, "4092700");
  assert.equal(scenarios.duplicateBaselineSucceeded(200, "2002700"), true);
  assert.equal(scenarios.duplicateBaselineSucceeded(409, "4092700"), false);
  assert.equal(scenarios.duplicateBaselineSucceeded(200, "4092700"), false);
  assert.equal(scenarios.duplicateBaselineSucceeded(null, "2002700"), false);
  assert.equal(scenarios.resolveProviderClientId({ clientId: "id-1", clientKey: "legacy" }), "id-1");
  assert.equal(scenarios.resolveProviderClientId({ clientKey: "legacy-only" }), "legacy-only");
  assert.equal(scenarios.normalizeProviderClientId({ clientKey: "legacy" }).clientId, "legacy");
  assert.equal(scenarios.normalizeProviderClientId({ clientId: "a", clientKey: "b" }).conflict, true);
  assert.equal(scenarios.normalizeProviderClientId({ clientId: "same", clientKey: "same" }).ok, true);
  assert.equal(scenarios.priorExternalIdFromRuns, undefined);
  assert.equal(scenarios.bankAcceptedDuplicateSeed, undefined);
  assert.equal(scenarios.bankRejectedDuplicateExternalId, undefined);
  const httpOnlyPositive = evaluateTest({ httpStatus: 200, expectedHttpStatus: 200, httpSource: "target_api" });
  assert.equal(httpOnlyPositive.status, "COMPLETED");
  assert.equal(finalOutcome(httpOnlyPositive.evaluation, true), "PASSED");
  const httpFailPositive = evaluateTest({ httpStatus: 401, expectedHttpStatus: 200, httpSource: "target_api" });
  assert.equal(httpFailPositive.status, "FAILED");
  assert.notEqual(scenarios.replacementAccessToken("real-token"), "real-token");
  const signature = "abcdefA";
  assert.notEqual(scenarios.corruptSignature(signature), signature);
  assert.equal(scenarios.unknownPartnerId("9296"), "AUTOSNAP-UNKNOWN-CLIENT");
  assert.throws(() => scenarios.unknownPartnerId("AUTOSNAP-UNKNOWN-CLIENT"), error => message(error).includes("sama dengan"));
  assert.match(scenarios.mintClientSimulatorExternalId(1_700_000_000_000), /^\d{1,36}$/);

  const valid = evaluateTest({ httpStatus: 401, expectedHttpStatus: 401, actualCode: "4012700", expectedCode: "4012700", actualMessage: "Unauthorized Signature", expectedMessage: "Unauthorized Signature", httpSource: "target_api" });
  assert.equal(valid.status, "COMPLETED");
  assert.equal(finalOutcome(valid.evaluation, true), "PASSED");
  assert.equal(finalOutcome(valid.evaluation, false), "COMPLETED");
  const otherMessage = evaluateTest({ httpStatus: 401, expectedHttpStatus: 401, actualCode: "4012700", expectedCode: "4012700", actualMessage: "Unauthorized Client", expectedMessage: "Unauthorized Signature", httpSource: "target_api" });
  assert.equal(otherMessage.status, "FAILED");
  assert.equal(finalOutcome(otherMessage.evaluation, true), "FAILED");
  const wrongHttp = evaluateTest({ httpStatus: 200, expectedHttpStatus: 401, actualCode: "4012701", expectedCode: "4012701", actualMessage: "Access Token Invalid", expectedMessage: "Access Token Invalid", httpSource: "target_api" });
  assert.equal(wrongHttp.status, "FAILED");
  const unverified = evaluateTest({ httpStatus: null, expectedHttpStatus: 401, actualCode: "4012701", expectedCode: "4012701", expectedMessage: "Access Token Invalid" });
  assert.equal(unverified.status, "AUTOMATION_ERROR");
  assert.equal(unverified.evaluation.cause, "HTTP_UNVERIFIED");
  const conflict = evaluateTest({ httpStatus: 409, expectedHttpStatus: 409, actualCode: "4092700", expectedCode: "4092700", actualMessage: "Conflict", expectedMessage: "Conflict", httpSource: "target_api" });
  assert.equal(finalOutcome(conflict.evaluation, true), "PASSED");
});

test("duplicate External ID mints once, baselines once, then one ASPI request", async () => {
  process.env.AUTOSNAP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const { encrypt } = await load("security.js");
  const { runClientSimulator } = await load("simulator-run.js");
  const { getXSignatureServiceFunction } = await load("simulator-signing.js");
  const { corruptSignature, DUPLICATE_BASELINE_FAILED } = await load("client-simulator-scenarios.js");
  const now = new Date().toISOString();
  const provider = { id: "prov", kind: "sim_provider", name: "Bank SUMUT", parent_id: null, partner_id: null, created_at: now, updated_at: now, data: { baseUrl: "https://dev.banksumut.co.id", clientId: "client-id-1", partnerId: "9296", clientSecret: encrypt("secret"), signatureAccessTokenMode: "NONE", signatureServiceMode: "FUNCTION", hmacEncoding: "base64", channelId: "0001", deviceId: "device-1", timestampConfig: { offsetMinutes: 420, includeMillis: false } } };
  const service = { id: "svc", kind: "sim_service", name: "Create VA", parent_id: "prov", partner_id: null, created_at: now, updated_at: now, data: { method: "POST", path: "/api/v1.0/transfer-va/create-va", defaultBody: "{}", serviceCode: "27" } };
  const user = { id: "snap", kind: "snap_user", name: "QA", parent_id: null, partner_id: null, created_at: now, updated_at: now, data: { email: "qa@example.test", password: encrypt("secret") } };
  const operator = { id: "op", username: "qa", email: "qa@example.test", name: "QA", role: "admin", active: true, privileges: [], created_at: now };
  const db = { query: async (sql, params) => { if (sql.includes("autosnap_external_ids")) return [{ external_id: params[1] }]; return []; } };
  const submitted = [];
  const gatewayFor = response => ({ submit: async (_user, form) => {
    submitted.push(form);
    return {
      httpStatus: response.httpStatus,
      httpSource: "target_api",
      response,
      responseText: "",
      activity: null,
      pdf: null,
      pdfError: null,
      steps: [{ stage: "aspi_send", sentExternalId: form.externalId, formExternalId: form.externalId, expectedExternalId: form.externalId, responseCode: response.responseCode }],
    };
  } });
  const conflictGateway = gatewayFor({ httpStatus: 409, responseCode: "4092700", responseMessage: "Conflict" });
  await assert.rejects(runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "DUPLICATE_EXTERNAL_ID" }, conflictGateway), error => message(error).includes("Konfirmasi"));
  assert.equal(submitted.length, 0);

  const baselineCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/transfer-va/create-va")) {
      const headers = init.headers || {};
      baselineCalls.push({ url: target, externalId: headers["X-EXTERNAL-ID"], clientKey: headers["X-CLIENT-KEY"], partnerId: headers["X-PARTNER-ID"], body: init.body });
      return new Response(JSON.stringify({ responseCode: "2002700", responseMessage: "Successful" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  let result;
  try {
    result = await runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "DUPLICATE_EXTERNAL_ID", confirmDuplicateExternalId: true }, conflictGateway);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(baselineCalls.length, 1, "exactly one baseline direct to bank");
  assert.equal(submitted.length, 1, "exactly one ASPI submit");
  assert.ok(baselineCalls[0].externalId);
  assert.equal(baselineCalls[0].externalId, submitted[0].externalId);
  assert.equal(baselineCalls[0].partnerId, "9296");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.httpStatus, 409);
  assert.equal(result.responseCode, "4092700");
  assert.ok(result.request.steps.some(step => step.stage === "duplicate_baseline" && step.ok === true));
  assert.equal(result.request.steps.some(step => step.stage === "duplicate_prove"), false);
  assert.equal(result.request.steps.some(step => step.stage === "duplicate_seed"), false);
  assert.equal(result.request.baselinePhase, "BASELINE_SUCCEEDED");
  assert.equal(result.request.aspiPhase, "ASPI_SENT");
  assert.equal(result.request.idempotency.externalId, baselineCalls[0].externalId);

  baselineCalls.length = 0;
  submitted.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/transfer-va/create-va")) {
      const headers = init.headers || {};
      baselineCalls.push({ externalId: headers["X-EXTERNAL-ID"] });
      return new Response(JSON.stringify({ responseCode: "4002700", responseMessage: "Bad Request" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    await assert.rejects(runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "DUPLICATE_EXTERNAL_ID", confirmDuplicateExternalId: true }, conflictGateway), error => message(error).startsWith(DUPLICATE_BASELINE_FAILED));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(baselineCalls.length, 1);
  assert.equal(submitted.length, 0, "failed baseline must not open ASPI");

  baselineCalls.length = 0;
  submitted.length = 0;
  let baselineStarted = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/transfer-va/create-va")) {
      baselineStarted = true;
      await new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 5));
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    await assert.rejects(runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "DUPLICATE_EXTERNAL_ID", confirmDuplicateExternalId: true }, conflictGateway), error => /timeout|Request timeout/i.test(message(error)));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(baselineStarted, true);
  assert.equal(submitted.length, 0, "unknown baseline must not open ASPI");

  const aspi200 = gatewayFor({ httpStatus: 200, responseCode: "2002700", responseMessage: "Successful" });
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/transfer-va/create-va")) {
      return new Response(JSON.stringify({ responseCode: "2002700", responseMessage: "Successful" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const failedDup = await runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "DUPLICATE_EXTERNAL_ID", confirmDuplicateExternalId: true }, aspi200);
    assert.equal(failedDup.status, "FAILED");
    assert.equal(failedDup.httpStatus, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const nullHttpGateway = { submit: async (_user, form) => {
    submitted.push(form);
    return { httpStatus: null, httpSource: "unavailable", response: { responseCode: "4092700", responseMessage: "Conflict" }, responseText: "", activity: null, pdf: null, pdfError: null, steps: [{ stage: "aspi_send", sentExternalId: form.externalId, formExternalId: form.externalId }] };
  } };
  submitted.length = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/transfer-va/create-va")) {
      return new Response(JSON.stringify({ responseCode: "2002700", responseMessage: "Successful" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const unverified = await runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "DUPLICATE_EXTERNAL_ID", confirmDuplicateExternalId: true }, nullHttpGateway);
    assert.equal(unverified.status, "AUTOMATION_ERROR");
    assert.notEqual(unverified.status, "PASSED");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const signatureGateway = gatewayFor({ httpStatus: 401, responseCode: "4012700", responseMessage: "Unauthorized Signature" });
  const signatureRun = await runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "INVALID_SIGNATURE" }, signatureGateway);
  const sent = submitted.at(-1);
  const relative = "/api/v1.0/transfer-va/create-va";
  const valid = getXSignatureServiceFunction("secret", sent.method, relative, "", sent.body, sent.timestamp, "base64");
  assert.equal(sent.signature, corruptSignature(valid));
  assert.notEqual(sent.signature, valid);
  assert.equal(sent.partnerId, "9296");
  assert.equal(signatureRun.matched, true);
  const unknown = await runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "UNKNOWN_CLIENT" }, gatewayFor({ httpStatus: 401, responseCode: "4012700", responseMessage: "Unauthorized Client" }));
  const unknownForm = submitted.at(-1);
  const unknownValid = getXSignatureServiceFunction("secret", unknownForm.method, relative, "", unknownForm.body, unknownForm.timestamp, "base64");
  assert.equal(unknownForm.signature, unknownValid);
  assert.equal(unknownForm.partnerId, "AUTOSNAP-UNKNOWN-CLIENT");
  assert.equal(unknown.matched, true);
  await assert.rejects(runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "INVALID_ACCESS_TOKEN" }, signatureGateway), error => message(error).includes("tidak dapat diisolasi"));
  const positive = await runClientSimulator(db, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "POSITIVE" }, gatewayFor({ httpStatus: 200, responseCode: "2002700", responseMessage: "Successful" }));
  const positiveForm = submitted.at(-1);
  const positiveValid = getXSignatureServiceFunction("secret", positiveForm.method, relative, "", positiveForm.body, positiveForm.timestamp, "base64");
  assert.equal(positiveForm.signature, positiveValid);
  assert.equal(positiveForm.partnerId, "9296");
  assert.equal(positiveForm.authorization, undefined);
  assert.equal(positive.matched, true);
  const tokenProvider = { ...provider, data: { ...provider.data, accessTokenUrl: "https://token.test/access-token" } };
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://token.test/access-token");
    return new Response(JSON.stringify({ responseCode: "2007300", accessToken: "real-token" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const tokenRun = await runClientSimulator(db, [tokenProvider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "INVALID_ACCESS_TOKEN" }, gatewayFor({ httpStatus: 401, responseCode: "4012701", responseMessage: "Access Token Invalid" }));
    const tokenForm = submitted.at(-1);
    assert.equal(tokenForm.authorization, "Bearer invalid-access-token");
    assert.equal(tokenForm.partnerId, "9296");
    const signedForSentToken = getXSignatureServiceFunction("secret", tokenForm.method, relative, "invalid-access-token", tokenForm.body, tokenForm.timestamp, "base64");
    const signedForRealToken = getXSignatureServiceFunction("secret", tokenForm.method, relative, "real-token", tokenForm.body, tokenForm.timestamp, "base64");
    assert.equal(tokenForm.signature, signedForSentToken);
    assert.notEqual(tokenForm.signature, signedForRealToken);
    assert.equal(tokenRun.matched, true);

    const hitCalls = [];
    globalThis.fetch = async (url, init = {}) => {
      const target = String(url);
      if (target === "https://token.test/access-token") {
        return new Response(JSON.stringify({ responseCode: "2007300", accessToken: "real-token" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      hitCalls.push({ url: target, headers: init.headers || {}, body: init.body });
      return new Response(JSON.stringify({ signature: "bank-signature-for-valid-token" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const hitProvider = {
      ...provider,
      data: {
        ...provider.data,
        accessTokenUrl: "https://token.test/access-token",
        signatureServiceMode: "HIT_API",
        signatureServiceUrl: "/api/v1.0.0/utilities/signature-service",
      },
    };
    const hitRun = await runClientSimulator(db, [hitProvider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "INVALID_ACCESS_TOKEN" }, gatewayFor({ httpStatus: 401, responseCode: "4012701", responseMessage: "Access Token Invalid" }));
    assert.equal(hitCalls.length, 1);
    assert.equal(hitCalls[0].headers.AccessToken, "real-token");
    const hitForm = submitted.at(-1);
    assert.equal(hitForm.authorization, "Bearer invalid-access-token");
    assert.equal(hitForm.signature, getXSignatureServiceFunction("secret", hitForm.method, relative, "invalid-access-token", hitForm.body, hitForm.timestamp, "base64"));
    assert.equal(hitRun.matched, true);
  } finally { globalThis.fetch = originalFetch; }
  const blocked = { query: async (sql) => sql.includes("autosnap_external_ids") ? [] : [] };
  await assert.rejects(runClientSimulator(blocked, [provider, service, user], operator, { providerId: "prov", serviceId: "svc", snapUserId: "snap", scenarioId: "POSITIVE", overrides: { externalId: "used-external" } }, signatureGateway), error => message(error).includes("sudah dipakai"));
});
