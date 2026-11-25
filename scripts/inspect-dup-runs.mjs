import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set search_path to autosnap, public");
const { rows } = await client.query(`
  SELECT id, scenario_id, status, http_status, response_code, created_at,
    request_json->'idempotency'->>'externalId' AS idem_ext,
    request_json->'headers'->>'X-EXTERNAL-ID' AS hdr_ext,
    request_json->'steps' AS steps
  FROM autosnap_runs
  WHERE mode='client_sim'
  ORDER BY created_at DESC
  LIMIT 8
`);
for (const r of rows) {
  const steps = Array.isArray(r.steps) ? r.steps : [];
  const seed = steps.find((s) => s && s.stage === "duplicate_seed");
  const prove = steps.find((s) => s && s.stage === "duplicate_prove");
  const aspi = steps.find((s) => s && s.stage === "aspi_send");
  console.log(JSON.stringify({
    id: r.id,
    scenario: r.scenario_id,
    status: r.status,
    http: r.http_status,
    code: r.response_code,
    created: r.created_at,
    idem: r.idem_ext,
    hdr: r.hdr_ext,
    seedExt: seed?.externalId ?? null,
    seedHttp: seed?.httpStatus ?? null,
    seedCode: seed?.responseCode ?? null,
    proveHttp: prove?.httpStatus ?? null,
    proveCode: prove?.responseCode ?? null,
    aspiHttp: aspi?.httpStatus ?? null,
    aspiCode: aspi?.responseCode ?? null,
    aspiSentExt: aspi?.sentExternalId ?? null,
  }));
}
await client.end();
