import assert from "node:assert/strict";
import test from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function load(name) {
  return import(pathToFileURL(join(root, "backend", "dist", name)).href);
}

test("evidence PDF filenames use registered API Service name only", async () => {
  const {
    sanitizeEvidenceFilenameBase,
    resolveRegisteredServiceName,
    evidencePdfFilename,
    evidencePdfFilenameForRun,
    uniqueEvidenceZipEntryNames,
    contentDispositionAttachment,
  } = await load("evidence-filename.js");

  assert.equal(evidencePdfFilename("Create VA"), "Create VA.pdf");
  assert.equal(evidencePdfFilename("API Bank Statement"), "API Bank Statement.pdf");
  assert.equal(sanitizeEvidenceFilenameBase("  a/b\\c:d*e?.pdf  "), "a b c d e .pdf");
  assert.equal(sanitizeEvidenceFilenameBase("../secret"), "secret");
  assert.equal(sanitizeEvidenceFilenameBase(""), "API Service");

  const clientSim = {
    identity: { serviceName: "Create VA", providerName: "Bank SUMUT", scenarioName: "Positif" },
    aspiServiceName: "Bank SUMUT - Create VA - Positif",
    activityName: "Bank SUMUT - Create VA - Positif",
  };
  assert.equal(resolveRegisteredServiceName(clientSim), "Create VA");
  assert.equal(evidencePdfFilenameForRun(clientSim, { service: "Bank SUMUT - Create VA - Positif", activityId: "abc" }), "Create VA.pdf");

  const devSite = { context: { service: "API Bank Statement", environment: "Sandbox" } };
  assert.equal(evidencePdfFilenameForRun(devSite), "API Bank Statement.pdf");

  assert.deepEqual(uniqueEvidenceZipEntryNames(["Create VA", "Create VA", "Transfer"]), ["Create VA.pdf", "Create VA (2).pdf", "Transfer.pdf"]);

  const disposition = contentDispositionAttachment("Create VA.pdf");
  assert.match(disposition, /filename="Create VA\.pdf"/);
  assert.match(disposition, /filename\*=UTF-8''Create%20VA\.pdf/);
});
