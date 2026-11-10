import { PGlite } from "@electric-sql/pglite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const envFile=join(process.cwd(),".env.local");
if(existsSync(envFile))process.loadEnvFile(envFile);
const directory=process.env.AUTOSNAP_PGLITE_DIR||join(process.cwd(),".autosnap-pg");
const db=new PGlite(directory);
try{
  await db.waitReady;
  const tables=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const counts=[];
  for(const {tablename} of tables.rows){
    const [{count}]= (await db.query(`SELECT COUNT(*)::integer AS count FROM ${tablename}`)).rows;
    counts.push({table:tablename,rows:count});
  }
  const records=await db.query("SELECT id,kind,name,parent_id,partner_id,created_at,updated_at FROM autosnap_records ORDER BY kind,name");
  console.log("\nTABEL AUTOSNAP");console.table(counts);
  console.log("\nMASTER DATA (secret tidak ditampilkan)");console.table(records.rows);
}finally{await db.close();}
