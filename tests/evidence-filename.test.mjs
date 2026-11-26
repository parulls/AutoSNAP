import assert from "node:assert/strict";
import test from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function load(name) {
  return import(pathToFileURL(join(root, "backend", "dist", name)).href);
}

test("evidence PDF filenames: Client Simulator uses Penyedia - Service - Skenario; Dev Site uses service name only", async () => {
  const {
    sanitizeEvidenceFilenameBase,
    resolveRegisteredServiceName,
    resolveEvidencePdfBaseName,
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
    mode: "client_sim",
    identity: { serviceName: "Create VA", providerName: "Bank SUMUT", scenarioName: "Positif", aspiServiceName: "Bank SUMUT - Create VA - Positif" },
    aspiServiceName: "Bank SUMUT - Create VA - Positif",
    activityName: "Bank SUMUT - Create VA - Positif",
  };
  assert.equal(resolveRegisteredServiceName(clientSim), "Create VA");
  assert.equal(resolveEvidencePdfBaseName(clientSim, { service: "Bank SUMUT - Create VA - Positif", activityId: "abc" }), "Bank SUMUT - Create VA - Positif");
  assert.equal(evidencePdfFilenameForRun(clientSim, { service: "Bank SUMUT - Create VA - Positif", activityId: "abc" }), "Bank SUMUT - Create VA - Positif.pdf");

  const devSite = { context: { service: "API Bank Statement", environment: "Sandbox" } };
  assert.equal(evidencePdfFilenameForRun(devSite), "API Bank Statement.pdf");

  assert.deepEqual(uniqueEvidenceZipEntryNames(["Create VA", "Create VA", "Transfer"]), ["Create VA.pdf", "Create VA (2).pdf", "Transfer.pdf"]);

  const disposition = contentDispositionAttachment("Bank SUMUT - Create VA - Positif.pdf");
  assert.match(disposition, /filename="Bank SUMUT - Create VA - Positif\.pdf"/);
  assert.match(disposition, /filename\*=UTF-8''Bank%20SUMUT%20-%20Create%20VA%20-%20Positif\.pdf/);
});
