import {PGlite} from "@electric-sql/pglite";
import pg from "pg";
import {existsSync} from "node:fs";
import {join,resolve} from "node:path";

const root=resolve(import.meta.dirname,".."),envFile=join(root,".env.local");
if(existsSync(envFile))process.loadEnvFile(envFile);
const connectionString=String(process.env.DATABASE_URL??"").trim();
if(!connectionString)throw new Error("DATABASE_URL Neon belum diisi pada .env.local.");
if(!/\.neon\.tech(?::\d+)?\//i.test(connectionString))throw new Error("DATABASE_URL bukan hostname Neon. Migrasi dibatalkan.");

const sourceDir=process.env.AUTOSNAP_PGLITE_DIR||join(root,".autosnap-pg");
if(!existsSync(sourceDir))throw new Error("Database lokal .autosnap-pg tidak ditemukan.");
const source=new PGlite(sourceDir),target=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:15_000,allowExitOnIdle:true});
const specs=[
  {table:"autosnap_users",columns:["id","email","username","name","salt","password_hash","role","active","created_at"],conflict:"id"},
  {table:"autosnap_records",columns:["id","kind","name","parent_id","partner_id","data","created_at","updated_at"],json:["data"],conflict:"id",update:true},
  {table:"autosnap_runs",columns:["id","client_id","project_id","environment_id","user_id","service_id","endpoint_id","scenario_id","mode","status","http_status","response_code","expected_code","duration_ms","request_json","response_json","notes","created_at"],json:["request_json","response_json"],conflict:"id"},
  {table:"autosnap_external_ids",columns:["environment_id","external_id","day"],conflict:"environment_id,external_id,day"},
];

await source.waitReady;
const client=await target.connect();
try{
  await client.query("BEGIN");
  for(const spec of specs){
    const rows=(await source.query(`SELECT ${spec.columns.join(",")} FROM ${spec.table}`)).rows;
    let imported=0;
    for(const row of rows){
      const values=spec.columns.map(column=>spec.json?.includes(column)?JSON.stringify(row[column]):row[column]);
      const placeholders=spec.columns.map((column,index)=>`$${index+1}${spec.json?.includes(column)?"::jsonb":""}`);
      const updates=spec.columns.filter(column=>!spec.conflict.split(",").includes(column)).map(column=>`${column}=EXCLUDED.${column}`).join(",");
      const conflict=spec.update?`DO UPDATE SET ${updates}`:"DO NOTHING";
      const result=await client.query(`INSERT INTO ${spec.table} (${spec.columns.join(",")}) VALUES (${placeholders.join(",")}) ON CONFLICT (${spec.conflict}) ${conflict} RETURNING 1`,values);
      imported+=result.rowCount??0;
    }
    process.stdout.write(`${spec.table}: ${imported}/${rows.length} baris dipindahkan\n`);
  }
  await client.query("COMMIT");
  process.stdout.write("Migrasi ke Neon selesai. Session login tidak dipindahkan; silakan login kembali.\n");
}catch(error){
  await client.query("ROLLBACK");throw error;
}finally{
  client.release();await target.end();await source.close();
}
