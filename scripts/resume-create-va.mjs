/**
 * Resume Create VA run via API (confirmMutatingRetry).
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Pool } from "pg";
import process from "node:process";

process.loadEnvFile(".env.local");
const require = createRequire(import.meta.url);
const { sha256 } = require("../backend/dist/security.js");

const runId = process.argv[2] || "RUN-20261120-58D75660";
const api = process.env.AUTOSNAP_API_URL || "http://127.0.0.1:4010";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});

const run = (
  await pool.query(`SELECT id, operator_id, status FROM autosnap_runs WHERE id=$1`, [runId])
).rows[0];
if (!run) {
  console.error("run missing");
  process.exit(1);
}
const token = randomBytes(32).toString("hex");
const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
await pool.query(
  `INSERT INTO autosnap_sessions (hash, user_id, expires_at) VALUES ($1,$2,$3)`,
  [sha256(token), run.operator_id, expiry],
);
await pool.end();

console.log(JSON.stringify({ runId, api, status: run.status }, null, 2));

const res = await fetch(`${api}/autosnap`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: `autosnap_session=${token}`,
  },
  body: JSON.stringify({
    action: "resumeTesting",
    id: runId,
    confirmMutatingRetry: true,
  }),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text.slice(0, 500) };
}
console.log("http", res.status);
console.log(JSON.stringify(body, null, 2));
process.exit(res.ok && body.ok && ["PASSED", "COMPLETED"].includes(body.status) ? 0 : 1);
