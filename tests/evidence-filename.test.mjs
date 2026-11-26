import assert from "node:assert/strict";
import test from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function load(name) {
  return import(pathToFileURL(join(root, "backend", "dist", name)).href);
}

test("evidence PDF filenames: Client Simulator full ASPI name; Dev Site per-activity service", async () => {
  const {
    sanitizeEvidenceFilenameBase,
    resolveRegisteredServiceName,
    resolveEvidencePdfBaseName,
    evidencePdfFilename,
    evidencePdfFilenameForRun,
    uniqueEvidenceZipEntryNames,
    contentDispositionAttachment,
    evidencePathLabel,
  } = await load("evidence-filename.js");
  const { buildEvidencePlan } = await load("evidence-plan.js");

  assert.equal(evidencePdfFilename("Create VA"), "Create VA.pdf");
  assert.equal(evidencePdfFilename("API Bank Statement"), "API Bank Statement.pdf");
  assert.equal(sanitizeEvidenceFilenameBase("  a/b\\c:d*e?.pdf  "), "a b c d e .pdf");
  assert.equal(sanitizeEvidenceFilenameBase("../secret"), "secret");
  assert.equal(sanitizeEvidenceFilenameBase(""), "API Service");
  assert.equal(evidencePathLabel("/api/v1.0/utilities/signature-auth"), "Signature Authentication");
  assert.equal(evidencePathLabel("/api/v1.0/access-token/b2b"), "Access Token B2B");
  assert.equal(evidencePathLabel("/api/v1.0/utilities/signature-service"), "Signature Service");

  const clientSim = {
    mode: "client_sim",
    identity: { serviceName: "Create VA", providerName: "Bank SUMUT", scenarioName: "Positif", aspiServiceName: "Bank SUMUT - Create VA - Positif" },
    aspiServiceName: "Bank SUMUT - Create VA - Positif",
    activityName: "Bank SUMUT - Create VA - Positif",
  };
  assert.equal(resolveRegisteredServiceName(clientSim), "Create VA");
  assert.equal(resolveEvidencePdfBaseName(clientSim, { service: "Bank SUMUT - Create VA - Positif", activityId: "abc" }), "Bank SUMUT - Create VA - Positif");
  assert.equal(evidencePdfFilenameForRun(clientSim, { service: "Bank SUMUT - Create VA - Positif", activityId: "abc" }), "Bank SUMUT - Create VA - Positif.pdf");

  const devSite = {
    context: { service: "Balance Inquiry", environment: "Sandbox" },
    evidence: {
      operations: [
        { path: "/api/v1.0/utilities/signature-auth", service: "Signature Authentication", activity: { activityId: "act-sig-auth", service: "Signature Authentication" } },
        { path: "/api/v1.0/utilities/signature-service", service: "Signature Service", activity: { activityId: "act-sig-svc", service: "Signature Service" } },
        { path: "/api/v1.0/balance-inquiry", service: "Balance Inquiry", activity: { activityId: "act-balance", service: "API Balance Inquiry" } },
      ],
    },
    aspiActivities: [
      { activityId: "act-sig-auth", service: "Signature Authentication", pdfReady: true },
      { activityId: "act-sig-svc", service: "Signature Service", pdfReady: true },
      { activityId: "act-balance", service: "API Balance Inquiry", pdfReady: true },
    ],
  };
  assert.equal(evidencePdfFilenameForRun(devSite, devSite.aspiActivities[0]), "Signature Authentication.pdf");
  assert.equal(evidencePdfFilenameForRun(devSite, devSite.aspiActivities[1]), "Signature Service.pdf");
  assert.equal(evidencePdfFilenameForRun(devSite, devSite.aspiActivities[2]), "API Balance Inquiry.pdf");
  assert.notEqual(evidencePdfFilenameForRun(devSite, devSite.aspiActivities[0]), "Balance Inquiry.pdf");

  // Activity without service still resolves via evidence.operations + activityId
  assert.equal(
    evidencePdfFilenameForRun(devSite, { activityId: "act-sig-auth" }),
    "Signature Authentication.pdf",
  );

  // Fallback without activity keeps registered/main service name
  assert.equal(evidencePdfFilenameForRun({ context: { service: "API Bank Statement" } }), "API Bank Statement.pdf");

  const plan = buildEvidencePlan(
    {
      status: 200,
      request: {
        steps: [
          { name: "/api/v1.0/utilities/signature-auth", method: "POST", httpStatus: 200 },
          { name: "/api/v1.0/access-token/b2b", method: "POST", httpStatus: 200 },
          { name: "/api/v1.0/utilities/signature-service", method: "POST", httpStatus: 200 },
        ],
      },
      activityBaseline: [],
    },
    "/api/v1.0/balance-inquiry",
    "POST",
    "Balance Inquiry",
    "qa@example.test",
  );
  assert.deepEqual(
    plan.operations.map((op) => op.service),
    ["Signature Authentication", "Access Token B2B", "Signature Service", "Balance Inquiry"],
  );

  assert.deepEqual(
    uniqueEvidenceZipEntryNames(["Signature Authentication", "Signature Authentication", "Balance Inquiry"]),
    ["Signature Authentication.pdf", "Signature Authentication (2).pdf", "Balance Inquiry.pdf"],
  );

  const disposition = contentDispositionAttachment("Signature Authentication.pdf");
  assert.match(disposition, /filename="Signature Authentication\.pdf"/);
  assert.match(disposition, /filename\*=UTF-8''Signature%20Authentication\.pdf/);
});
