import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set search_path to autosnap, public");
const { rows } = await client.query(`
  SELECT scenario_id, http_status, response_code,
    request_json->'headers'->>'X-PARTNER-ID' AS partner,
    request_json->'headers'->>'X-EXTERNAL-ID' AS external_id,
    request_json->'headers'->>'CHANNEL-ID' AS channel,
    created_at
  FROM autosnap_runs
  WHERE mode='client_sim'
  ORDER BY created_at DESC
  LIMIT 6
`);
for (const r of rows) console.log(JSON.stringify(r));
const provider = (await client.query(`SELECT data->>'partnerId' AS partner, data->>'clientKey' AS client_key, data->>'clientId' AS client_id, data->>'channelId' AS channel FROM autosnap_records WHERE kind='sim_provider' LIMIT 1`)).rows[0];
const service = (await client.query(`SELECT data->>'partnerId' AS partner, data->>'channelId' AS channel, left(coalesce(data->>'defaultBody',''), 200) AS body FROM autosnap_records WHERE kind='sim_service' LIMIT 1`)).rows[0];
console.log("provider", JSON.stringify(provider));
console.log("service", JSON.stringify(service));
await client.end();
