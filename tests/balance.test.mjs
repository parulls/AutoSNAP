import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createHmac, generateKeyPairSync, randomBytes, verify } from "node:crypto";

const require = createRequire(import.meta.url);
const { validateBalanceRequest, balanceResponseChecks, mockBalance, validateHeaderProfile } = require("../backend/dist/balance.js");
const { encrypt, decrypt, redact } = require("../backend/dist/security.js");
const { RunEngine } = require("../backend/dist/run-engine.js");
const { DatabaseService } = require("../backend/dist/database.service.js");
const { AutoSnapController } = require("../backend/dist/app.js");
const { request } = require("playwright-core");

test("Balance Inquiry validates conditional identity, data types and header values", () => {
  assert.deepEqual(validateBalanceRequest({ accountNo: "2000100101", balanceTypes: ["Cash"] }, false), []);
  assert.equal(validateBalanceRequest({}, false).length, 1);
  assert.deepEqual(validateBalanceRequest({}, true), []);
  assert.equal(validateBalanceRequest({ accountNo: 2000100101, balanceTypes: "Cash", additionalInfo: [] }, false).length, 4);
  assert.ok(validateHeaderProfile({ ipAddress: "172.24.281.24" }).length);
  assert.ok(validateHeaderProfile({ origin: "example.com\r\nX-Foo: injected" }).length);
  assert.deepEqual(validateHeaderProfile({ ipAddress: "172.31.255.255", latitude: "-6.1617169", longitude: "106.664394" }), []);
});

test("HTTP 200 alone is not a pass; optional response fields and negative cases follow expectations", () => {
  const body = { partnerReferenceNo: "ref", accountNo: "2000100101" };
  const response = mockBalance(body, "2001100");
  assert.ok(balanceResponseChecks(200, response, "2001100", body).every(x => x.passed));
  assert.ok(balanceResponseChecks(200, { html: "not SNAP" }, "2001100", body).some(x => !x.passed));
  assert.ok(balanceResponseChecks(200, { ...response, partnerReferenceNo: "other" }, "2001100", body).some(x => !x.passed));
  assert.ok(balanceResponseChecks(200, { ...response, accountInfos: [{ amount: { value: "1000", currency: "IDR" } }] }, "2001100", body).some(x => !x.passed));
  assert.ok(balanceResponseChecks(401, { responseCode: "4011101", responseMessage: "Invalid Token" }, "4011101", body).every(x => x.passed));
  assert.ok(balanceResponseChecks(200, { responseCode: "2001100", responseMessage: "Successful" }, "2001100", body).every(x => x.passed));
});

test("live engine signs the exact transmitted body, uses Client ID and separates B2B from B2B2C", async () => {
  process.env.AUTOSNAP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTOSNAP_ALLOWED_HOSTS = "sandbox.example";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const client = { id: "client", partner_id: "legacy", data: { clientId: "client-key", partnerIdSource: "client_id", privateKey: encrypt(privateKey), clientSecret: encrypt("secret"), channelId: "95221", deviceId: "device" } };
  const user = { id: "user", data: { customerToken: encrypt("customer-token") } };
  const calls = [];
  const saved = request.newContext;
  request.newContext = async () => ({ fetch: async (url, options) => {
    calls.push({ url, ...options });
    const token = url.endsWith("/access-token/b2b");
    return { status: () => 200, text: async () => JSON.stringify(token ? { accessToken: "b2b-token" } : { responseCode: "2001100", responseMessage: "Successful" }), headers: () => ({ "content-type": "application/json" }) };
  }, dispose: async () => {} });
  try {
    const input = { baseUrl: "https://sandbox.example", path: "/api/v1.0/balance-inquiry", method: "POST", body: { accountNo: "2000100101" }, client, user, scenarioId: null, externalId: "12345", extraHeaders: { ORIGIN: "example.com" }, authFlow: "token_b2b", useCase: "B2B", rsaEncoding: "hex" };
    const result = await new RunEngine().hit(input);
    assert.equal(calls.length, 2);
    assert.ok(verify("RSA-SHA256", Buffer.from("client-key|" + calls[0].headers["X-TIMESTAMP"]), publicKey, Buffer.from(calls[0].headers["X-SIGNATURE"], "hex")));
    const service = calls[1];
    assert.equal(service.headers["X-PARTNER-ID"], "client-key");
    assert.equal(service.headers.Authorization, "Bearer b2b-token");
    assert.equal(service.headers["Authorization-Customer"], undefined);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(service.data).digest("hex");
    assert.equal(service.headers["X-SIGNATURE"], createHmac("sha512", "secret").update("POST:/api/v1.0/balance-inquiry:b2b-token:" + hash + ":" + service.headers["X-TIMESTAMP"]).digest("hex"));
    assert.ok(!JSON.stringify(result.request).includes("customer-token"));
    assert.ok(!JSON.stringify(result.request).includes("b2b-token"));
    calls.length = 0;
    await new RunEngine().hit({ ...input, useCase: "B2B2C" });
    assert.equal(calls[1].headers["Authorization-Customer"], "Bearer customer-token");
  } finally { request.newContext = saved; }
});

test("database/controller flow: credentials, Balance Inquiry variables and mock history", async () => {
  process.env.AUTOSNAP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.NODE_ENV = "test";process.env.AUTOSNAP_TEST_PGLITE = "memory://";
  process.env.AUTOSNAP_RECAPTCHA_SITE_KEY = "test-site";
  process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY = "test-secret";
  process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES = "localhost";
  const savedFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({success:true,hostname:"localhost"})});
  const db = new DatabaseService();
  await db.onModuleInit();
  const engine = new RunEngine();
  const controller = new AutoSnapController(db, engine);
  let session = "";
  const req = { headers: { cookie: "" }, hostname: "localhost" };
  const call = async (action, payload = {}) => {
    req.headers.cookie = session;
    req.body = { action, ...payload };
    const res = { code: 200, status(n) { this.code = n; return this; }, json(body) { return { status: this.code, body }; }, cookie(key, value) { session = key + "=" + value; }, clearCookie() {} };
    return controller.action(req, res);
  };
  try {
    assert.equal((await call("setup", { username: "qa-admin", password: "test-password-123",recaptchaToken:"test-token" })).status, 200);
    const client = await call("save", { kind: "client", name: "SNAP Bank Sumut", data: { clientId: "test-client", partnerIdSource: "client_id", clientSecret: "test-secret", channelId: "95221" } });
    assert.equal(client.status, 200);
    const project = await call("save", { kind: "project", name: "Project", parentId: client.body.id });
    const environment = await call("save", { kind: "environment", name: "ASPI Sandbox", parentId: project.body.id, data: { category: "Dev Site", mode: "mock", useCase: "B2B", authFlow: "token_b2b" } });
    const user = await call("save", { kind: "snap_user", name: "Registration", data: { email: "snap@example.test", password: "snap-password", accountNo: "2000100101", bankCardToken: "registration-card-token" } });
    await call("save", { id: environment.body.id, kind: "environment", name: "ASPI Sandbox", parentId: project.body.id, data: { category: "Dev Site", mode: "mock", useCase: "B2B", authFlow: "token_b2b", defaultUserId: user.body.id } });
    const stored = await db.one("SELECT * FROM autosnap_records WHERE id=$1", [client.body.id]);
    assert.equal(stored.partner_id, "test-client");
    assert.notEqual(stored.data.clientSecret, "test-secret");
    const storedUser = await db.one("SELECT * FROM autosnap_records WHERE id=$1", [user.body.id]);
    assert.equal(decrypt(storedUser.data.accountNo), "2000100101");
    const input = { clientId: client.body.id, projectId: project.body.id, environmentId: environment.body.id, userId: user.body.id, serviceId: "seed-service-10", endpointId: "seed-endpoint-10", useCase: "B2B", body: JSON.stringify({ partnerReferenceNo: "{{partner_reference_no}}", accountNo: "{{registration.accountNo}}", bankCardToken: "{{registration.bankCardToken}}", balanceTypes: ["Cash"] }) };
    const result = await call("run", input);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "Passed");
    assert.equal(result.body.responseCode, "2001100");
    assert.equal(result.body.response.accountNo, "[REDACTED]");
    const negative = await call("run", { ...input, testType: "invalid_access_token" });
    assert.equal(negative.status, 200);
    assert.equal(negative.body.status, "Passed");
    assert.equal(negative.body.httpStatus, 401);
    assert.equal(negative.body.responseCode, "4011101");
    assert.equal(negative.body.expectedCode, "4011101");
    assert.match(negative.body.notes,/sesuai ekspektasi/i);
    const run = await db.one("SELECT * FROM autosnap_runs WHERE id=$1", [result.body.id]);
    assert.equal(run.request_json.headers["X-PARTNER-ID"], "test-client");
    assert.equal(run.request_json.context.useCase, "B2B");
    assert.ok(run.request_json.validation.every(x => x.passed));
    assert.ok(!JSON.stringify(run).includes("registration-card-token"));
    assert.equal((await call("run", { ...input, useCase: "B2B2C" })).status, 400);
    const reusedRegistration = await call("run", { ...input, body: "{}" });
    assert.equal(reusedRegistration.status, 200,"empty Balance body reuses the selected User SNAP registration data");
    assert.equal(reusedRegistration.body.status,"Passed");
    assert.equal((await call("run", { ...input, serviceId: "seed-service-16", endpointId: "seed-endpoint-16" })).status, 400);
    assert.equal((await call("run", { ...input, scenarioId: "4.6" })).status, 400);
    assert.equal((await call("run", { ...input, externalId: "not-numeric" })).status, 400);
    const duplicate = await call("run", { ...input, scenarioId: "3.5", externalId: run.request_json.externalId });
    assert.equal(duplicate.body.status, "Passed");
    assert.equal(duplicate.body.responseCode, "4091100");
    const savedTemplate = await db.one("SELECT data FROM autosnap_records WHERE id='seed-template-10'");
    assert.equal(JSON.parse(savedTemplate.data.body).accountNo, "2000100101");
    const custom=JSON.stringify({accountNo:"9876543210",additionalInfo:{custom:true}});
    await db.query("UPDATE autosnap_records SET data=jsonb_set(data,'{body}',$1::jsonb) WHERE id='seed-template-10'",[JSON.stringify(custom)]);
    const preserved=await db.one("SELECT data FROM autosnap_records WHERE id='seed-template-10'");
    assert.equal(preserved.data.body,custom,"custom request templates must not be rewritten by runtime upgrades");
    assert.equal(redact({ cardData: "encrypted-card", authCode: "auth", privateKey: "key" }).cardData, "[REDACTED]");
  } finally { globalThis.fetch=savedFetch;await db.onModuleDestroy(); }
});
