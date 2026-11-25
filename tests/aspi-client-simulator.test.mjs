import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

async function load() {
  try { return await import(pathToFileURL(join(root, "backend", "dist", "aspi-client-simulator.js")).href); }
  catch {
    process.env.TS_NODE_TRANSPILE_ONLY = "1";
    require("ts-node/register/transpile-only");
    return require(join(root, "backend", "src", "aspi-client-simulator.ts"));
  }
}

test("service name keeps a single Positive or Negative Case suffix", async () => {
  const { clientSimulatorServiceName } = await load();
  assert.equal(clientSimulatorServiceName("Create VA", "positive"), "Create VA - Positive Case");
  assert.equal(clientSimulatorServiceName("Create VA", "negative"), "Create VA - Negative Case");
  assert.equal(clientSimulatorServiceName("Create VA - Positive Case", "positive"), "Create VA - Positive Case");
});

test("activity id is read only from the ASPI portal download link", async () => {
  const { activityIdFromPortalUrl } = await load();
  const id = "196f2867-1431-413b-a488-5de643800730";
  assert.equal(activityIdFromPortalUrl(`https://apidevportal.aspi-indonesia.or.id/client-simulator/download?activityId=${id}`), id);
  assert.equal(activityIdFromPortalUrl("https://example.com/download?activityId=" + id), null);
  assert.equal(activityIdFromPortalUrl("javascript:download(1)"), null);
});

const idA = "196f2867-1431-413b-a488-5de643800730";
const idB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const row = (activityId, service) => ({ activityId, service, timestamp: "", downloadUrl: `https://apidevportal.aspi-indonesia.or.id/client-simulator-activity?activityId=${activityId}`, text: service });

test("a new official activity id is kept only when it is the single id absent from the baseline", async () => {
  const { pickNewClientSimulatorActivity, officialActivityId } = await load();
  assert.equal(officialActivityId("Create VA - Positive Case"), null);
  assert.equal(officialActivityId("2026-11-24-create-va"), null);
  const before = new Set([idA]);
  const rows = [row(idA, "Create VA - Positive Case"), row(idB, "Create VA - Positive Case")];
  assert.equal(pickNewClientSimulatorActivity(before, rows, "Create VA - Positive Case").activityId, idB);
  assert.equal(pickNewClientSimulatorActivity(before, [...rows, row("bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Create VA - Positive Case")], "Create VA - Positive Case"), null);
  assert.equal(pickNewClientSimulatorActivity(before, [row(idA, "Create VA - Positive Case")], "Create VA - Positive Case"), null);
});

test("activity match is an exact activity id and ignores a repeated service name", async () => {
  const { findActivityById, matchClientSimulatorActivity, clientSimulatorRetryTarget, ACTIVITY_ID_UNAVAILABLE } = await load();
  const rows = [row(idA, "Create VA - Positive Case"), row(idB, "Create VA - Positive Case")];
  assert.equal(findActivityById(rows, idB).activity.activityId, idB);
  assert.equal(findActivityById(rows, "missing").code, "ASPI_ACTIVITY_NOT_FOUND");
  assert.equal(matchClientSimulatorActivity(rows, { serviceName: "Create VA - Positive Case" }).code, "ASPI_ACTIVITY_NOT_FOUND");
  assert.equal(clientSimulatorRetryTarget([], "").message, ACTIVITY_ID_UNAVAILABLE);
  assert.equal(clientSimulatorRetryTarget([{ activityId: idA, service: "Create VA - Positive Case" }, { activityId: idB, service: "Create VA - Positive Case" }], idA).activityId, idA);
  assert.equal(clientSimulatorRetryTarget([{ activityId: idA }], idB).code, "ASPI_ACTIVITY_NOT_FOUND");
  assert.equal(clientSimulatorRetryTarget([{ service: "Create VA - Positive Case" }, { service: "Create VA - Positive Case" }]).code, "ACTIVITY_ID_UNRESOLVED");
});

test("save result http status is classified by redirect path and is not saved until an activity id is proven", async () => {
  const { classifySaveHttp, proveSavedActivity } = await load();
  const ok = classifySaveHttp(200, null);
  assert.equal(ok.state, "UNKNOWN");
  assert.equal(ok.verified, false);
  assert.equal(proveSavedActivity(ok, row(idA, "Create VA - Positive Case")).state, "SAVED");
  const activityRedirect = classifySaveHttp(302, "https://apidevportal.aspi-indonesia.or.id/client-simulator-activity?activityId=" + idA + "&session=secret");
  assert.equal(activityRedirect.state, "REDIRECTED");
  assert.equal(activityRedirect.redirectPath, "/client-simulator-activity");
  assert.equal(activityRedirect.activityId, idA);
  assert.equal(activityRedirect.verified, false);
  assert.equal(JSON.stringify(activityRedirect).includes("session=secret"), false);
  assert.equal(classifySaveHttp(302, "https://apidevportal.aspi-indonesia.or.id/sign-in?returnUrl=/client-simulator").state, "AUTH_EXPIRED");
  assert.equal(classifySaveHttp(302, null).state, "UNKNOWN");
  assert.equal(classifySaveHttp(500, "/client-simulator").state, "REJECTED");
});

test("evidence keeps the official activity id when the pdf is not stored", async () => {
  const { buildSimulatorActivityEvidence } = await load();
  const pending = buildSimulatorActivityEvidence({ runId: "run-1", activityId: idA, serviceId: "svc", serviceName: "Create VA - Positive Case", testType: "positive", pdfReady: false, evidenceStatus: "FAILED" });
  assert.equal(pending.activityId, idA);
  assert.equal(pending.pdfReady, false);
  assert.equal(pending.evidenceStatus, "FAILED");
  assert.equal(buildSimulatorActivityEvidence({ runId: "run-1", activityId: "Create VA - Positive Case", serviceId: "svc", serviceName: "Create VA", testType: "positive" }), null);
});

test("pass or fail follows the response shown by ASPI", async () => {
  const { evaluateClientSimulator } = await load();
  assert.equal(evaluateClientSimulator({ testType: "positive", httpStatus: 200, responseCode: "2002400", expectedHttp: null, expectedCode: "2002400" }).status, "PASSED");
  assert.equal(evaluateClientSimulator({ testType: "negative", httpStatus: 200, responseCode: "2002400", expectedHttp: null, expectedCode: null }).status, "FAILED");
  assert.equal(evaluateClientSimulator({ testType: "positive", httpStatus: null, responseCode: "", expectedHttp: null, expectedCode: null }).status, "COMPLETED");
  const unverified = evaluateClientSimulator({ testType: "positive", httpStatus: null, responseCode: "2002700", expectedHttp: 200, expectedCode: null });
  assert.equal(unverified.status, "COMPLETED");
  assert.equal(unverified.matched, false);
  assert.equal(unverified.httpVerified, false);
  assert.equal(unverified.snapVerified, true);
});
