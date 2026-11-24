import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(import.meta.url);

async function load(){
  try{return await import(pathToFileURL(join(root,"backend","dist","privileges.js")).href);}
  catch{
    process.env.TS_NODE_TRANSPILE_ONLY="1";
    require("ts-node/register/transpile-only");
    return require(join(root,"backend","src","privileges.ts"));
  }
}

test("a module privilege grants every action in that module",async()=>{
  const {can}=await load();
  const user={role:"petugas",privileges:["master_data"]};
  assert.equal(can(user,"master_data","view"),true);
  assert.equal(can(user,"master_data","create"),true);
  assert.equal(can(user,"master_data","update"),true);
  assert.equal(can(user,"master_data","delete"),true);
  assert.equal(can(user,"user_management"),false);
});

test("legacy CRUD and split privileges collapse into the module they granted",async()=>{
  const {can,normalizedPrivileges}=await load();
  const stored=["master_data_create","dev_site_evidence","client_simulator_manage","history_all","obsolete"];
  assert.deepEqual(normalizedPrivileges(stored,"petugas"),["master_data","dev_site","client_simulator","history_all"]);
  const user={role:"petugas",privileges:stored};
  assert.equal(can(user,"master_data","delete"),true);
  assert.equal(can(user,"dev_site","evidence"),true);
  assert.equal(can(user,"dev_site","run"),true);
  assert.equal(can(user,"client_simulator","manage"),true);
  assert.equal(can(user,"client_simulator","run"),true);
  assert.equal(can(user,"history","view_all"),true);
});

test("privilege escalation is rejected for non-admin",async()=>{
  const {assertAssignablePrivileges}=await load();
  const actor={role:"petugas",privileges:["dashboard","master_data_update"]};
  assert.throws(()=>assertAssignablePrivileges(actor,["dashboard","user_management"]),(err)=>err?.status===403&&/privilege/i.test(err.error));
  assert.deepEqual(assertAssignablePrivileges(actor,["dashboard","master_data_delete"]),["dashboard","master_data"]);
});

test("database migration rewrites stored legacy privileges into modules",async()=>{
  process.env.NODE_ENV="test";
  process.env.AUTOSNAP_TEST_PGLITE="memory://module-privileges";
  const {DatabaseService}=require(join(root,"backend","dist","database.service.js"));
  const db=new DatabaseService();
  await db.onModuleInit();
  try{
    await db.query("INSERT INTO autosnap_users (id,email,username,name,salt,password_hash,role,active,privileges,created_at) VALUES ($1,$2,$3,$4,$5,$6,'petugas',TRUE,$7::jsonb,$8)",["legacy-user","legacy@example.test","legacy-user","Legacy","salt","hash",JSON.stringify(["master_data_delete","dev_site_evidence","client_simulator_manage","history_all","obsolete"]),new Date().toISOString()]);
    const sql=readFileSync(join(root,"migrations","017_module_privileges.sql"),"utf8").split("\n").filter(line=>!line.trim().startsWith("--")&&!/^SET search_path/i.test(line.trim())).join("\n");
    await db.query(sql);
    const row=await db.one("SELECT privileges FROM autosnap_users WHERE id=$1",["legacy-user"]);
    assert.deepEqual([...row.privileges].sort(),["client_simulator","dev_site","history_all","master_data"]);
  }finally{await db.onModuleDestroy();}
});

test("admin always can, and history_all stays separate from other modules",async()=>{
  const {can}=await load();
  assert.equal(can({role:"admin",privileges:[]},"user_management","delete"),true);
  assert.equal(can({role:"petugas",privileges:["history_all"]},"history","view_all"),true);
  assert.equal(can({role:"petugas",privileges:["history_all"]},"dev_site"),false);
  assert.equal(can({role:"petugas",privileges:["dashboard"]},"history","view_all"),false);
  assert.equal(can({role:"petugas",privileges:["dev_site"]},"history","view_all"),false);
  assert.equal(can({role:"petugas",privileges:["dev_site"]},"dev_site","evidence"),true);
});
