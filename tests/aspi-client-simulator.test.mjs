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

test("service name is provider, service, and the typed scenario", async () => {
  const { buildClientSimulatorServiceName } = await load();
  assert.equal(buildClientSimulatorServiceName("Bank SUMUT", "Create VA", "Positive Case"), "Bank SUMUT - Create VA - Positive Case");
  assert.equal(buildClientSimulatorServiceName("Bank SUMUT", "Create VA", "Negative Case"), "Bank SUMUT - Create VA - Negative Case");
  assert.equal(buildClientSimulatorServiceName("Bank SUMUT", "Balance Inquiry", "Saldo Tidak Cukup"), "Bank SUMUT - Balance Inquiry - Saldo Tidak Cukup");
  assert.equal(buildClientSimulatorServiceName("Bank ABC", "Transfer", "Invalid Signature"), "Bank ABC - Transfer - Invalid Signature");
  assert.equal(buildClientSimulatorServiceName(" Bank SUMUT ", "Create VA", "  Positive   Case "), "Bank SUMUT - Create VA - Positive Case");
  assert.equal(buildClientSimulatorServiceName("Bank SUMUT", "Create VA - Positive Case", "Retry"), "Bank SUMUT - Create VA - Positive Case - Retry");
  assert.throws(() => buildClientSimulatorServiceName("Bank SUMUT", "Create VA", "   "), error => error.error === "Nama Skenario wajib diisi sebelum menjalankan Client Simulator.");
  assert.throws(() => buildClientSimulatorServiceName("Bank SUMUT", "Create VA", "Baris\nbaru"), error => /karakter kontrol/.test(error.error));
  assert.throws(() => buildClientSimulatorServiceName("Bank SUMUT", "Create VA", "A".repeat(240)), error => /maksimal 255/.test(error.error));
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

test("client simulator uses the shared evaluator and final outcome", async () => {
  const { evaluateClientSimulator, clientSimulatorEvidenceOutcome, clientSimulatorDispatchOutcome, classifyTargetHttp, clientSimulatorServiceLabel } = await load();
  const { finalOutcome } = await import(pathToFileURL(join(root, "backend", "dist", "test-evaluation.js")).href);
  const matchedSnap = evaluateClientSimulator({ testType: "positive", httpStatus: 200, responseCode: "2002400", expectedHttp: null, expectedCode: "2002400", httpSource: "target_api" });
  assert.equal(matchedSnap.status, "COMPLETED");
  assert.equal(matchedSnap.evaluation.mode, "SNAP_AND_HTTP");
  assert.equal(finalOutcome(matchedSnap.evaluation, false), "COMPLETED");
  assert.equal(finalOutcome(matchedSnap.evaluation, true), "PASSED");
  assert.equal(evaluateClientSimulator({ testType: "negative", httpStatus: 200, responseCode: "2002400", expectedHttp: null, expectedCode: null }).status, "FAILED");
  const unverified = evaluateClientSimulator({ testType: "positive", httpStatus: null, responseCode: "2002700", expectedHttp: 200, expectedCode: null });
  assert.equal(unverified.status, "AUTOMATION_ERROR");
  assert.equal(unverified.evaluation.cause, "HTTP_UNVERIFIED");
  assert.equal(unverified.httpVerified, false);
  assert.equal(unverified.snapVerified, false);
  assert.equal(unverified.evaluation.httpValidation.source, "unavailable");
  assert.equal(finalOutcome(unverified.evaluation, true), "AUTOMATION_ERROR");
  const httpOnly = evaluateClientSimulator({ httpStatus: 200, responseCode: "2002700", expectedHttp: null, expectedCode: null, httpSource: "target_api" });
  assert.equal(httpOnly.status, "COMPLETED");
  assert.equal(httpOnly.evaluation.mode, "HTTP_ONLY");
  assert.equal(finalOutcome(httpOnly.evaluation, true), "PASSED");
  const explicitSnap = evaluateClientSimulator({ testType: "negative", httpStatus: 200, responseCode: "4002400", expectedHttp: null, expectedCode: "4002400", httpSource: "target_api" });
  assert.equal(explicitSnap.evaluation.mode, "SNAP_AND_HTTP");
  assert.equal(finalOutcome(explicitSnap.evaluation, true), "PASSED");
  assert.equal(evaluateClientSimulator({ httpStatus: 500, responseCode: "5002700", expectedHttp: 200, expectedCode: null, httpSource: "target_api" }).status, "FAILED");
  assert.equal(evaluateClientSimulator({ httpStatus: 200, responseCode: "2002700", expectedHttp: 400, expectedCode: null, httpSource: "target_api" }).status, "FAILED");
  const mismatchedSnap = evaluateClientSimulator({ httpStatus: 200, responseCode: "4002700", expectedHttp: 200, expectedCode: "2002700", httpSource: "target_api" });
  assert.equal(mismatchedSnap.status, "FAILED");
  assert.equal(finalOutcome(mismatchedSnap.evaluation, true), "FAILED");
  const emptySnap = evaluateClientSimulator({ httpStatus: 200, responseCode: "", expectedHttp: 200, expectedCode: "2002700", httpSource: "target_api" });
  assert.equal(emptySnap.status, "FAILED");
  assert.equal(clientSimulatorEvidenceOutcome(unverified.evaluation, true, "AUTOMATION_ERROR"), "AUTOMATION_ERROR");
  assert.equal(clientSimulatorEvidenceOutcome(httpOnly.evaluation, false, "COMPLETED"), "COMPLETED");
  assert.equal(clientSimulatorEvidenceOutcome(httpOnly.evaluation, true, "COMPLETED"), "PASSED");
  assert.equal(clientSimulatorEvidenceOutcome({ matched: false }, true, "COMPLETED"), "COMPLETED");
  assert.equal(clientSimulatorDispatchOutcome("SEND_STARTED", true), "UNKNOWN");
  assert.equal(clientSimulatorDispatchOutcome("SEND_STARTED", false), "UNKNOWN");
  assert.equal(clientSimulatorDispatchOutcome("NOT_SENT", true), "CANCELLED");
  assert.equal(clientSimulatorDispatchOutcome("NOT_SENT", false), "AUTOMATION_ERROR");
  const bank = "https://bank.example.test/api/v1.0/transfer-va/create-va";
  assert.deepEqual(classifyTargetHttp({ serviceUri: bank, observed: [{ url: bank, status: 200 }, { url: "https://apidevportal.aspi-indonesia.or.id/ClientSimulator/ClientSimulatorSave", status: 302 }] }), { httpStatus: 200, httpVerified: true, httpSource: "target_api" });
  assert.deepEqual(classifyTargetHttp({ serviceUri: bank, observed: [{ url: "https://apidevportal.aspi-indonesia.or.id/ClientSimulator/ClientSimulatorSave", status: 302 }] }), { httpStatus: null, httpVerified: false, httpSource: "unavailable" });
  assert.equal(clientSimulatorServiceLabel(["No", "Date", "Service Name"], ["1", "2026-11-25", "Bank SUMUT - Create VA - Positive Case"]).service, "Bank SUMUT - Create VA - Positive Case");
  assert.equal(clientSimulatorServiceLabel([], ["1", "2026-11-25", "1"]).serviceSource, "unavailable");
});

test("two activities with the same service name stay on their own activity id", async () => {
  const { matchClientSimulatorActivity } = await load();
  const same = "Bank SUMUT - Create VA - Positive Case";
  const rows = [row(idA, same), row(idB, same)];
  assert.equal(matchClientSimulatorActivity(rows, { activityId: idB, serviceName: same }).activity.activityId, idB);
  assert.equal(matchClientSimulatorActivity(rows, { serviceName: same }).ok, false);
});
