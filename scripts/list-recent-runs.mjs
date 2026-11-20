import { Pool } from "pg";
import process from "node:process";
process.loadEnvFile(".env.local");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=autosnap,public",
});
const r = await pool.query(`
  SELECT id, status, http_status, created_at, operator_id, user_id,
    request_json->'context'->>'endpoint' AS endpoint,
    request_json->'reprocess' AS reprocess,
    request_json->'pdfCounts' AS pdf,
    request_json->'aspiActivities' AS acts,
    request_json->'evidence' AS evidence
  FROM autosnap_runs
  ORDER BY created_at DESC
  LIMIT 8
`);
console.log(
  JSON.stringify(
    r.rows.map((x) => ({
      id: x.id,
      status: x.status,
      http: x.http_status,
      endpoint: x.endpoint,
      operator_id: x.operator_id,
      user_id: x.user_id,
      reprocess: x.reprocess,
      pdf: x.pdf,
      acts: (Array.isArray(x.acts) ? x.acts : []).map((a) => ({
        id: a.activityId,
        service: a.service,
        path: a.path,
        pdfReady: a.pdfReady,
      })),
      ops: Array.isArray(x.evidence?.operations)
        ? x.evidence.operations.map((o) => ({
            key: o.key,
            path: o.path,
            pdfReady: o.pdfReady,
            activityId: o.activityId,
          }))
        : [],
      created: x.created_at,
    })),
    null,
    2,
  ),
);
await pool.end();
