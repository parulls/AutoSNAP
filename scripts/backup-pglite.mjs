import { PGlite } from "@electric-sql/pglite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const stamp=new Date().toISOString().replace(/[:.]/g,"-");
const source=process.env.AUTOSNAP_PGLITE_DIR||join(process.cwd(),".autosnap-pg");
const directory=join(process.cwd(),"backups",`pglite-${stamp}`);
await mkdir(directory,{recursive:true});
const db=new PGlite(source);
try{
  await db.waitReady;
  const tables=["autosnap_users","autosnap_sessions","autosnap_records","autosnap_runs","autosnap_external_ids","autosnap_evidence_pdfs","autosnap_password_resets","autosnap_automation_leases","autosnap_rate_limits","autosnap_test_progress"];
  const data={version:1,createdAt:new Date().toISOString(),tables:{}};
  for(const table of tables){
    if(!(await db.query("SELECT to_regclass($1) AS name",[table])).rows[0]?.name)continue;
    data.tables[table]=(await db.query(`SELECT * FROM ${table}`)).rows;
  }
  await writeFile(join(directory,"logical-backup.json"),JSON.stringify(data,null,2),{encoding:"utf8",flag:"wx"});
  console.log(directory);
}finally{await db.close();}
