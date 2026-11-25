import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(`
  select table_schema, table_name
  from information_schema.tables
  where table_name ilike '%run%' or table_name ilike '%autosnap%'
  order by 1, 2
`);
console.log(rows);
await client.end();
