import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {readFileSync} from "node:fs";
const require=createRequire(import.meta.url);
const {DatabaseService}=require("../backend/dist/database.service.js");
const {readHistory}=require("../backend/dist/history.js");
const {createAccount}=require("../backend/dist/accounts.js");
const ts=require("typescript");
const periodModule={exports:{}};
new Function("require","module","exports",ts.transpileModule(readFileSync(new URL("../app/history-period.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(require,periodModule,periodModule.exports);
const {rangeForPeriod}=periodModule.exports;

test("calendar periods use WIB, Monday weeks, leap months and year boundaries",()=>{
  const midnight=new Date("2026-11-16T17:00:00Z");
  assert.deepEqual(rangeForPeriod("today",midnight),{period:"today",from:"2026-11-17",to:"2026-11-17"});
  assert.deepEqual(rangeForPeriod("week",midnight),{period:"week",from:"2026-11-16",to:"2026-11-22"});
  assert.deepEqual(rangeForPeriod("month",new Date("2024-02-28T18:00:00Z")),{period:"month",from:"2024-02-01",to:"2024-02-29"});
  assert.deepEqual(rangeForPeriod("week",new Date("2027-01-01T00:00:00Z")),{period:"week",from:"2026-12-28",to:"2027-01-03"});
});

test("history filters are inclusive in WIB, owner scoped, paginated and not limited to latest 500",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const user=await createAccount(db,{username:"history-a",email:"history-a@example.test",password:"history-password-123"},"petugas",true);
    const other=await createAccount(db,{username:"history-b",email:"history-b@example.test",password:"history-password-123"},"petugas",true);
    const insert=async(id,owner,time,mode="portal")=>db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,service_id,endpoint_id,mode,status,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','s','ep',$3,'PASSED',$4::jsonb,'{}'::jsonb,$5)",[id,owner,mode,JSON.stringify({context:{service:"Balance Inquiry",environment:"Dev Site A"}}),time]);
    await insert("before",user,"2026-11-16T16:59:59.999Z");
    await insert("start",user,"2026-11-16T17:00:00.000Z");
    await insert("end",user,"2026-11-17T16:59:59.999Z","mock");
    await insert("after",user,"2026-11-17T17:00:00.000Z");
    await insert("foreign",other,"2026-11-17T00:00:00.000Z");
    const range={from:"2026-11-17",to:"2026-11-17",limit:1};
    let result=await readHistory(db,user,range);assert.equal(result.total,2);assert.equal(result.runs[0].id,"end");assert.equal(result.summary.dev,1);assert.equal(result.summary.simulator,1);
    result=await readHistory(db,user,{...range,offset:1});assert.equal(result.runs[0].id,"start");
    result=await readHistory(db,user,{...range,mode:"dev_site",search:"Balance"});assert.equal(result.total,1);assert.equal(result.runs[0].id,"start");
    assert.equal((await readHistory(db,other,range)).runs[0].id,"foreign");
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,service_id,endpoint_id,mode,status,request_json,response_json,created_at) SELECT 'old-' || n,$1,'c','p','e','s','ep','portal','PASSED','{}'::jsonb,'{}'::jsonb,'2025-01-01T00:00:00.000Z' FROM generate_series(1,505) n",[user]);
    result=await readHistory(db,user,{from:"2025-01-01",to:"2025-01-01",offset:500,limit:20});assert.equal(result.total,505);assert.equal(result.runs.length,5);
    await assert.rejects(readHistory(db,user,{from:"2026-02-30",to:"2026-03-01"}),error=>error.status===400);
    await assert.rejects(readHistory(db,user,{from:"2026-11-18",to:"2026-11-17"}),error=>error.status===400);
  }finally{await db.onModuleDestroy();}
});
