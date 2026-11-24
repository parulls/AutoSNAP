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

test("a new activity row is used only when its text uniquely contains the Service Name", async () => {
  const { pickNewClientSimulatorActivity } = await load();
  const before = new Set(["old"]);
  const rows = [
    { activityId: "old", service: "Create VA - Positive Case", timestamp: "", downloadUrl: "https://apidevportal.aspi-indonesia.or.id/a", text: "Create VA - Positive Case" },
    { activityId: "new-1", service: "Create VA - Positive Case", timestamp: "", downloadUrl: "https://apidevportal.aspi-indonesia.or.id/b", text: "Create VA - Positive Case" },
    { activityId: "new-2", service: "Inquiry VA - Negative Case", timestamp: "", downloadUrl: "https://apidevportal.aspi-indonesia.or.id/c", text: "Inquiry VA - Negative Case" },
  ];
  assert.equal(pickNewClientSimulatorActivity(before, rows, "Create VA - Positive Case")?.activityId, "new-1");
  const ambiguous = [...rows, { ...rows[1], activityId: "new-3" }];
  assert.equal(pickNewClientSimulatorActivity(before, ambiguous, "Create VA - Positive Case"), null);
  assert.equal(pickNewClientSimulatorActivity(before, rows, "Update VA - Positive Case"), null);
});

test("pass or fail follows the response shown by ASPI", async () => {
  const { evaluateClientSimulator } = await load();
  assert.deepEqual(evaluateClientSimulator({ testType: "positive", httpStatus: 200, responseCode: "2002400", expectedHttp: null, expectedCode: "2002400" }), { matched: true, status: "PASSED" });
  assert.equal(evaluateClientSimulator({ testType: "negative", httpStatus: 200, responseCode: "2002400", expectedHttp: null, expectedCode: null }).status, "FAILED");
  assert.equal(evaluateClientSimulator({ testType: "positive", httpStatus: null, responseCode: "", expectedHttp: null, expectedCode: null }).status, "COMPLETED");
  assert.equal(evaluateClientSimulator({ testType: "positive", httpStatus: null, responseCode: "2002700", expectedHttp: 200, expectedCode: null }).status, "PASSED");
});
