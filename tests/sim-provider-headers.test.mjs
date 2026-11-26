import { createRequire as __createRequireHttp } from "node:module";
const __requireHttp = __createRequireHttp(import.meta.url);
const { RunEvidenceService } = __requireHttp("../backend/dist/run-evidence.js");
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const { DatabaseService } = require("../backend/dist/database.service.js");
const { AutoSnapController } = require("../backend/dist/app.js");
const { RunEngine } = require("../backend/dist/run-engine.js");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

async function withController(run) {
  process.env.NODE_ENV = "test";
  process.env.AUTOSNAP_TEST_PGLITE = "memory://";
  process.env.AUTOSNAP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTOSNAP_RECAPTCHA_SITE_KEY = "test-site";
  process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY = "test-secret";
  process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES = "localhost";
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true, hostname: "localhost" }) });
  const db = new DatabaseService();
  await db.onModuleInit();
  const controller = new AutoSnapController(db, new RunEngine(), null, null, new RunEvidenceService(db, null));
  let session = "";
  const call = async (action, payload = {}) => {
    const req = { headers: { cookie: session }, hostname: "localhost", body: { action, ...payload } };
    const res = { code: 200, status(n) { this.code = n; return this; }, json(body) { return { status: this.code, body }; }, cookie(k, v) { session = `${k}=${v}`; }, clearCookie() {} };
    return controller.action(req, res);
  };
  try {
    await call("setup", { username: "cs-admin", email: "cs-admin@example.test", password: "long-password-123", recaptchaToken: "test-token" });
    await run(call, db);
  } finally {
    globalThis.fetch = savedFetch;
    await db.onModuleDestroy();
  }
}

const baseProvider = {
  kind: "sim_provider",
  name: "Bank SUMUT",
  data: {
    baseUrl: "https://dev.banksumut.co.id",
    clientId: "client-1",
    clientSecret: "secret",
    privateKey,
    partnerId: "9296",
    channelId: "0001",
    deviceId: "device-1",
    signatureAccessTokenMode: "FUNCTION",
    signatureServiceMode: "FUNCTION",
  },
};

test("sim_provider save requires CHANNEL-ID, X-DEVICE-ID, and valid X-PARTNER-ID like Dev Site headers", async () => {
  await withController(async (call, db) => {
    const missingChannel = await call("save", { ...baseProvider, data: { ...baseProvider.data, channelId: "" } });
    assert.equal(missingChannel.status, 400);
    assert.match(missingChannel.body.error, /CHANNEL-ID/);

    const missingDevice = await call("save", { ...baseProvider, data: { ...baseProvider.data, deviceId: "" } });
    assert.equal(missingDevice.status, 400);
    assert.match(missingDevice.body.error, /X-DEVICE-ID/);

    const longChannel = await call("save", { ...baseProvider, data: { ...baseProvider.data, channelId: "123456" } });
    assert.equal(longChannel.status, 400);
    assert.match(longChannel.body.error, /CHANNEL-ID maksimal 5/);

    const badPartner = await call("save", { ...baseProvider, data: { ...baseProvider.data, partnerId: "bad partner" } });
    assert.equal(badPartner.status, 400);
    assert.match(badPartner.body.error, /X-PARTNER-ID/);

    const ok = await call("save", baseProvider);
    assert.equal(ok.status, 200);
    const stored = await db.one("SELECT * FROM autosnap_records WHERE id=$1", [ok.body.id]);
    assert.equal(stored.partner_id, null, "sim_provider keeps partner_id column null to avoid UNIQUE clash with Dev Site");
    assert.equal(stored.data.partnerId, "9296");
    assert.equal(stored.data.channelId, "0001");
    assert.equal(stored.data.deviceId, "device-1");

    const duplicate = await call("save", { ...baseProvider, name: "Bank lain", data: { ...baseProvider.data, clientId: "client-2" } });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /X-PARTNER-ID sudah dipakai/);

    const serviceOk = await call("save", { kind: "sim_service", name: "Create VA", parentId: ok.body.id, data: { method: "POST", path: "/api/v1.0/transfer-va/create-va", defaultBody: "{}" } });
    assert.equal(serviceOk.status, 200);

    const serviceBadChannel = await call("save", { kind: "sim_service", name: "Create VA Bad", parentId: ok.body.id, data: { method: "POST", path: "/api/v1.0/x", channelId: "too-long", defaultBody: "{}" } });
    assert.equal(serviceBadChannel.status, 400);
    assert.match(serviceBadChannel.body.error, /CHANNEL-ID maksimal 5/);
  });
});
