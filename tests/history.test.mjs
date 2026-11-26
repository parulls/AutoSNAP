import {aspiDownloadFixture} from "./aspi-download-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {readFileSync} from "node:fs";
const require=createRequire(import.meta.url);
const {DatabaseService}=require("../backend/dist/database.service.js");
const {readHistory,canAccessRun}=require("../backend/dist/history.js");
const {createAccount}=require("../backend/dist/accounts.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {RunEvidenceService}=require("../backend/dist/run-evidence.js");
const {randomUUID}=require("node:crypto");
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
    const viewer={id:user,role:"petugas"},otherViewer={id:other,role:"petugas"};
    const insert=async(id,owner,time,mode="portal")=>db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,service_id,endpoint_id,mode,status,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','s','ep',$3,'PASSED',$4::jsonb,'{}'::jsonb,$5)",[id,owner,mode,JSON.stringify({context:{service:"Balance Inquiry",environment:"Dev Site A"},operator:{id:owner,name:"Hist",username:owner===user?"history-a":"history-b",role:"petugas"}}),time]);
    await insert("before",user,"2026-11-16T16:59:59.999Z");
    await insert("start",user,"2026-11-16T17:00:00.000Z");
    await insert("end",user,"2026-11-17T16:59:59.999Z","client_sim");
    await insert("after",user,"2026-11-17T17:00:00.000Z");
    await insert("foreign",other,"2026-11-17T00:00:00.000Z");
    const range={from:"2026-11-17",to:"2026-11-17",limit:1};
    let result=await readHistory(db,viewer,range);assert.equal(result.total,2);assert.equal(result.runs[0].id,"end");assert.equal(result.summary.dev,1);assert.equal(result.summary.simulator,1);
    assert.equal(result.runs[0].operator.mine,true);
    result=await readHistory(db,viewer,{...range,offset:1});assert.equal(result.runs[0].id,"start");
    result=await readHistory(db,viewer,{...range,mode:"dev_site",search:"Balance"});assert.equal(result.total,1);assert.equal(result.runs[0].id,"start");
    assert.equal((await readHistory(db,otherViewer,range)).runs[0].id,"foreign");
    await assert.rejects(readHistory(db,viewer,{...range,scope:"all"}),error=>error.status===403);
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,service_id,endpoint_id,mode,status,request_json,response_json,created_at) SELECT 'old-' || n,$1,'c','p','e','s','ep','portal','PASSED','{}'::jsonb,'{}'::jsonb,'2025-01-01T00:00:00.000Z' FROM generate_series(1,505) n",[user]);
    result=await readHistory(db,viewer,{from:"2025-01-01",to:"2025-01-01",offset:500,limit:20});assert.equal(result.total,505);assert.equal(result.runs.length,5);
    await assert.rejects(readHistory(db,viewer,{from:"2026-02-30",to:"2026-03-01"}),error=>error.status===400);
    await assert.rejects(readHistory(db,viewer,{from:"2026-11-18",to:"2026-11-17"}),error=>error.status===400);
  }finally{await db.onModuleDestroy();}
});

test("admin sees all operators, filters by role/user/status, and petugas cannot read foreign PDF",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=Buffer.alloc(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const adminId=await createAccount(db,{username:"hist-admin",email:"hist-admin@example.test",password:"history-password-123"},"admin",true);
    const petugasId=await createAccount(db,{username:"hist-petugas",email:"hist-petugas@example.test",password:"history-password-123"},"petugas",true);
    const otherId=await createAccount(db,{username:"hist-other",email:"hist-other@example.test",password:"history-password-123"},"petugas",true);
    const now="2026-11-17T08:00:00.000Z";
    const activityId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const insert=async(id,owner,status,role,username,withActivity=false)=>db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,service_id,endpoint_id,mode,status,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','svc-1','ep-1','portal',$3,$4::jsonb,'{}'::jsonb,$5)",[id,owner,status,JSON.stringify({context:{service:"Balance Inquiry",environment:"Dev Site"},operator:{id:owner,name:username,username,role},...(withActivity?{aspiActivities:[{activityId,service:"balance",pdfReady:true}]}:{})}),now]);
    await insert("admin-run",adminId,"PASSED","admin","hist-admin");
    await insert("petugas-run",petugasId,"FAILED","petugas","hist-petugas",true);
    await insert("other-run",otherId,"COMPLETED","petugas","hist-other");
    const storedPdf=aspiDownloadFixture("history");
    await db.query("INSERT INTO autosnap_evidence_pdfs(run_id,activity_id,service,pdf_data,byte_size,verification_status,created_at) VALUES('petugas-run',$1,'balance',$2,$3,'CAPTURED',$4)",[activityId,storedPdf,storedPdf.length,now]);

    const admin={id:adminId,role:"admin",username:"hist-admin",name:"Admin",privileges:[]};
    const petugas={id:petugasId,role:"petugas",username:"hist-petugas",name:"Petugas",privileges:["dev_site"]};
    const all=await readHistory(db,admin,{from:"2026-11-17",to:"2026-11-17",scope:"all",limit:20});
    assert.equal(all.total,3);
    assert.ok(all.runs.some(run=>run.id==="petugas-run"));
    assert.ok(all.byOperator.length>=2);

    const onlyPetugas=await readHistory(db,admin,{from:"2026-11-17",to:"2026-11-17",scope:"all",operatorRole:"petugas",limit:20});
    assert.equal(onlyPetugas.total,2);
    const oneUser=await readHistory(db,admin,{from:"2026-11-17",to:"2026-11-17",scope:"all",operatorId:petugasId,limit:20});
    assert.equal(oneUser.total,1);assert.equal(oneUser.runs[0].id,"petugas-run");
    const failed=await readHistory(db,admin,{from:"2026-11-17",to:"2026-11-17",scope:"all",status:"FAILED",limit:20});
    assert.equal(failed.total,1);
    const mine=await readHistory(db,admin,{from:"2026-11-17",to:"2026-11-17",scope:"mine",limit:20});
    assert.equal(mine.total,1);assert.equal(mine.runs[0].operator.mine,true);

    assert.equal(canAccessRun(admin,{operator_id:petugasId}),true);
    assert.equal(canAccessRun(petugas,{operator_id:otherId}),false);

    const evidence=new RunEvidenceService(db,{collectEvidence:async()=>[]});
    const controller=new AutoSnapController(db,null,null,null,evidence);
    controller.user=async()=>petugas;controller.enforceRateLimit=async()=>{};
    const denied=await controller.action({body:{action:"downloadAspiActivityPdf",id:"other-run",activityId},headers:{}},{code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};},setHeader(){},send(buf){return {status:this.code,body:buf};}});
    assert.equal(denied.status,404);

    controller.user=async()=>admin;
    const needDownloadConfirm=await controller.action({body:{action:"downloadAspiActivityPdf",id:"petugas-run",activityId},headers:{}},{code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};},setHeader(){},send(buf){return {status:this.code,body:buf};}});
    assert.equal(needDownloadConfirm.status,409);
    assert.equal(needDownloadConfirm.body.code,"CROSS_USER_CONFIRM");

    const allowed=await controller.action({body:{action:"downloadAspiActivityPdf",id:"petugas-run",activityId,confirmCrossUser:true},headers:{}},{code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};},setHeader(){},send(buf){return {status:this.code,body:buf};}});
    assert.equal(allowed.status,200,JSON.stringify(allowed.body));
    assert.ok(Buffer.isBuffer(allowed.body)||allowed.body instanceof Uint8Array);

    const needConfirm=await controller.action({body:{action:"retryAspiEvidence",id:"petugas-run"},headers:{}},{code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};}});
    assert.equal(needConfirm.status,409);
    assert.equal(needConfirm.body.code,"CROSS_USER_CONFIRM");
  }finally{await db.onModuleDestroy();}
});

test("admin cross-user reprocess keeps ownership and records actor audit",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=Buffer.alloc(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const {sha256}=require("../backend/dist/security.js");
    const adminId=await createAccount(db,{username:"retry-admin",email:"retry-admin@example.test",password:"history-password-123"},"admin",true);
    const petugasId=await createAccount(db,{username:"retry-petugas",email:"retry-petugas@example.test",password:"history-password-123"},"petugas",true);
    const now=new Date().toISOString();
    const runId=randomUUID();
    const evaluation={mode:"HTTP_ONLY",snapValidationPerformed:false,outcome:"COMPLETED",stage:"evaluation",stageLabel:"Validasi HTTP",detail:"HTTP 200 sesuai expected 200.",suggestion:"",httpValidation:{expectedStatus:200,actualStatus:200,performed:true,matches:true,source:"target_api"}};
    const evidence={version:1,phase:"INCOMPLETE",retryCount:0,accountHash:sha256("snap@example.test"),beforeIds:[],operations:[{key:"op-0",path:"/api/v1.0/balance-inquiry",service:"balance",attempts:0,pdfReady:false,activity:{activityId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01",service:"balance",timestamp:now,downloadUrl:"https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity"}}]};
    await db.query("INSERT INTO autosnap_records(id,kind,name,parent_id,data,created_at,updated_at) VALUES('snap-user','snap_user','SNAP',null,$1::jsonb,$2,$2)",[JSON.stringify({email:"snap@example.test",password:"fixture"}),now]);
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,mode,status,http_status,response_code,expected_code,duration_ms,notes,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','snap-user','s','ep','portal','COMPLETED',200,'2001100',null,10,'open',$3::jsonb,'{}'::jsonb,$4)",[runId,petugasId,JSON.stringify({evaluation,evidence,outcome:"COMPLETED",operator:{id:petugasId,name:"Petugas",username:"retry-petugas",role:"petugas"}}),now]);
    const portal={collectEvidence:async input=>input.operations.map(item=>({key:item.key,path:item.path,activity:item.activity,pdf:aspiDownloadFixture("cross"),attempts:1}))};
    const service=new RunEvidenceService(db,portal);
    const controller=new AutoSnapController(db,null,portal,null,service);
    const admin={id:adminId,role:"admin",username:"retry-admin",name:"Admin",privileges:[]};
    controller.user=async()=>admin;controller.enforceRateLimit=async()=>{};
    const result=await controller.action({body:{action:"retryAspiEvidence",id:runId,confirmCrossUser:true},headers:{}},{code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};}});
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.status,"PASSED");
    const row=await db.one("SELECT operator_id,status,request_json FROM autosnap_runs WHERE id=$1",[runId]);
    assert.equal(row.operator_id,petugasId,"ownership must stay with petugas");
    assert.equal(row.status,"PASSED");
    const audit=row.request_json.reprocessAudit.at(-1);
    assert.equal(audit.actorUsername,"retry-admin");
    assert.equal(audit.crossUser,true);
    assert.equal(audit.ownerOperatorId,petugasId);
  }finally{await db.onModuleDestroy();}
});
