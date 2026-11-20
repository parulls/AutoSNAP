/**
 * Evidence-only retry for a COMPLETED run (no API re-execution).
 */
import process from "node:process";
import { createRequire } from "node:module";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { DatabaseService } = require("../backend/dist/database.service.js");
const { AspiSessionManager } = require("../backend/dist/aspi-session-manager.js");
const { AspiFormResolver } = require("../backend/dist/aspi-form-resolver.js");
const { PortalEngine } = require("../backend/dist/portal-engine.js");
const { RunEvidenceService } = require("../backend/dist/run-evidence.js");

const runId = process.argv[2] || "RUN-20261120-1F4A2040";

const db = new DatabaseService();
await db.onModuleInit();
const sessions = new AspiSessionManager(db);
const portal = new PortalEngine(sessions, new AspiFormResolver());
const evidence = new RunEvidenceService(db, portal);

const run = await db.one(
  "SELECT id, operator_id, user_id, status FROM autosnap_runs WHERE id=$1",
  [runId],
);
if (!run) {
  console.error("run not found", runId);
  process.exit(1);
}
const user = await db.one(
  "SELECT * FROM autosnap_records WHERE id=$1 AND kind='snap_user'",
  [run.user_id],
);
if (!user) {
  console.error("snap_user missing");
  process.exit(1);
}

console.log(JSON.stringify({ runId, status: run.status, user: user.name }, null, 2));
const result = await evidence.process({
  runId,
  ownerId: run.operator_id,
  user,
  initial: false,
  actor: {
    id: run.operator_id,
    username: "cli-retry",
    name: "CLI Evidence Retry",
    role: "admin",
  },
  onProgress: async (stage, status, detail) => {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${status.toUpperCase()} ${stage} — ${detail || ""}`);
  },
});
console.log(
  JSON.stringify(
    {
      status: result.status,
      complete: result.complete,
      stored: result.stored,
      required: result.required,
      notes: result.notes,
      missing: result.missing,
      pdfCounts: result.pdfCounts,
      reprocess: result.reprocess,
    },
    null,
    2,
  ),
);
await db.onModuleDestroy?.();
process.exit(result.complete ? 0 : 1);
