import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root=resolve(import.meta.dirname,"..");
const oldDir=join(root,".wrangler","state","v3","d1","miniflare-D1DatabaseObject");
const candidates=existsSync(oldDir)?readdirSync(oldDir).filter(name=>name.endsWith(".sqlite")&&name!=="metadata.sqlite").map(name=>join(oldDir,name)):[];
const oldPath=process.argv[2]??candidates[0];
if(!oldPath||!existsSync(oldPath))throw new Error("Database D1 lama tidak ditemukan.");
const source=new DatabaseSync(oldPath,{readOnly:true});
const available=new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
if(!available.has("autosnap_users")||!available.has("autosnap_records"))throw new Error("File SQLite ini bukan database AutoSNAP lama.");
const pg=new PGlite(join(root,".autosnap-pg"));
await pg.waitReady;
try{
  await pg.query("SELECT 1 FROM autosnap_users LIMIT 1");
  const specs=[
    {table:"autosnap_users",columns:["id","email","name","salt","password_hash","created_at"]},
    {table:"autosnap_records",columns:["id","kind","name","parent_id","partner_id","data","created_at","updated_at"],json:["data"]},
    {table:"autosnap_runs",columns:["id","client_id","project_id","environment_id","user_id","service_id","endpoint_id","scenario_id","mode","status","http_status","response_code","expected_code","duration_ms","request_json","response_json","notes","created_at"],json:["request_json","response_json"]},
    {table:"autosnap_external_ids",columns:["environment_id","external_id","day"]},
  ];
  for(const spec of specs){
    if(!available.has(spec.table))continue;
    const rows=source.prepare(`SELECT ${spec.columns.join(",")} FROM ${spec.table}`).all();
    let imported=0;
    for(const row of rows){
      const values=spec.columns.map(column=>row[column]);
      const placeholders=spec.columns.map((column,index)=>`$${index+1}${spec.json?.includes(column)?"::jsonb":""}`);
      const result=await pg.query(`INSERT INTO ${spec.table} (${spec.columns.join(",")}) VALUES (${placeholders.join(",")}) ON CONFLICT DO NOTHING RETURNING 1 AS inserted`,values);
      imported+=result.rows.length;
    }
    process.stdout.write(`${spec.table}: ${imported} imported, ${rows.length-imported} already present\n`);
  }
}finally{await pg.close();source.close();}
