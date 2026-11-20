import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

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

test("legacy master_data privilege grants create/update/delete",async()=>{
  const {can}=await load();
  const user={role:"petugas",privileges:["master_data"]};
  assert.equal(can(user,"master_data","view"),true);
  assert.equal(can(user,"master_data","create"),true);
  assert.equal(can(user,"master_data","delete"),true);
});

test("granular privilege without menu key still allows action",async()=>{
  const {can}=await load();
  const user={role:"petugas",privileges:["master_data_create","dashboard"]};
  assert.equal(can(user,"master_data","create"),true);
  assert.equal(can(user,"master_data","delete"),false);
  assert.equal(can(user,"master_data","view"),true);
});

test("privilege escalation is rejected for non-admin",async()=>{
  const {assertAssignablePrivileges}=await load();
  const actor={role:"petugas",privileges:["dashboard","master_data"]};
  assert.throws(()=>assertAssignablePrivileges(actor,["dashboard","user_management"]),(err)=>err?.status===403&&/privilege/i.test(err.error));
  assert.deepEqual(assertAssignablePrivileges(actor,["dashboard","master_data"]),["dashboard","master_data"]);
});

test("admin always can, history_all enables view_all",async()=>{
  const {can}=await load();
  assert.equal(can({role:"admin",privileges:[]},"user_management","delete"),true);
  assert.equal(can({role:"petugas",privileges:["history_all"]},"history","view_all"),true);
  assert.equal(can({role:"petugas",privileges:["dashboard"]},"history","view_all"),false);
});
