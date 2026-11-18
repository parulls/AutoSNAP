import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {randomBytes,randomUUID} from "node:crypto";
const require=createRequire(import.meta.url);
const {finalOutcome,evaluateTest}=require("../backend/dist/test-evaluation.js");
const {buildCheckpoint,markStage,canRetryEvidence,canResumeTesting,requiresMutatingConfirm,stageCompleted}=require("../backend/dist/run-checkpoint.js");
const {DatabaseService}=require("../backend/dist/database.service.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {createAccount}=require("../backend/dist/accounts.js");
const {encrypt}=require("../backend/dist/security.js");
const {RunEvidenceService}=require("../backend/dist/run-evidence.js");

test("finalOutcome promotes COMPLETED to PASSED only when PDFs complete",()=>{
  const matched=evaluateTest({httpStatus:200,expectedHttpStatus:200,cancelled:false}).evaluation;
  assert.equal(finalOutcome(matched,false),"COMPLETED");
  assert.equal(finalOutcome(matched,true),"PASSED");
  const failed=evaluateTest({httpStatus:500,expectedHttpStatus:200,cancelled:false}).evaluation;
  assert.equal(finalOutcome(failed,true),"FAILED","PDF complete must never heal HTTP FAILED");
});

test("checkpoint helpers gate retry evidence, resume, and mutating confirm",()=>{
  const nodes=[{stage:"signature_auth"},{stage:"access_token"},{stage:"signature_service"},{stage:"api_request"}];
  let checkpoint=buildCheckpoint(nodes);
  assert.equal(checkpoint.stages[0].id,"preparing");
  assert.ok(checkpoint.stages.some(s=>s.id==="evidence"));
  checkpoint=markStage(checkpoint,"signature_auth","COMPLETED");
  checkpoint=markStage(checkpoint,"access_token","FAILED","timeout");
  assert.equal(stageCompleted(checkpoint,"signature_auth"),true);
  assert.equal(canRetryEvidence({status:"COMPLETED",httpMatched:true,evidenceIncomplete:true}),true);
  assert.equal(canRetryEvidence({status:"FAILED",httpMatched:false,evidenceIncomplete:true}),true);
  assert.equal(canRetryEvidence({status:"RUNNING",httpMatched:true,evidenceIncomplete:true}),false);
  assert.equal(canResumeTesting({status:"AUTOMATION_ERROR",hasTargetHttp:false,failedStageId:"access_token"}),true);
  assert.equal(canResumeTesting({status:"FAILED",hasTargetHttp:true,failedStageId:"evaluation"}),false);
  assert.equal(requiresMutatingConfirm("POST",false,true),true);
  assert.equal(requiresMutatingConfirm("GET",false,true),false);
  assert.equal(requiresMutatingConfirm("POST",true,true),false);
});

test("retryAspiEvidence promotes COMPLETED to PASSED and keeps HTTP FAILED",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const {sha256}=require("../backend/dist/security.js");
    const owner=await createAccount(db,{username:"retry-owner",email:"retry@example.test",password:"retry-password-123"},"admin",true);
    const now=new Date().toISOString();
    await db.query("INSERT INTO autosnap_records(id,kind,name,data,created_at,updated_at) VALUES('retry-user','snap_user','QA',$1::jsonb,$2,$2)",[JSON.stringify({email:"qa@example.test",password:encrypt("fixture")}),now]);
    const paths=["/api/v1.0/utilities/signature-auth","/api/v1.0/access-token/b2b","/api/v1.0/utilities/signature-service","/api/v1.0/balance-inquiry"];
    const ops=paths.map((path,i)=>({key:`op-${i}`,path,service:path,attempts:0,pdfReady:false,activity:{activityId:`aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee${i}`,service:path,timestamp:now,downloadUrl:"https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity"}}));
    const evaluation={mode:"HTTP_ONLY",snapValidationPerformed:false,outcome:"COMPLETED",stage:"evaluation",stageLabel:"Validasi HTTP",detail:"HTTP 200 sesuai expected 200.",suggestion:"",httpValidation:{expectedStatus:200,actualStatus:200,performed:true,matches:true,source:"target_api"}};
    const evidence={version:1,phase:"INCOMPLETE",retryCount:0,accountHash:sha256("qa@example.test"),beforeIds:[],operations:ops};
    const runId=randomUUID();
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,mode,status,http_status,response_code,expected_code,duration_ms,notes,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','retry-user','s','ep','portal','COMPLETED',200,'2001100',null,10,'incomplete',$3::jsonb,'{}'::jsonb,$4)",[runId,owner,JSON.stringify({evaluation,evidence,outcome:"COMPLETED",progressLog:[{stage:"evaluation",status:"completed",detail:"awal",at:now}]}),now]);
    let downloads=0;
    const portal={collectEvidence:async input=>{
      downloads++;
      return input.operations.map(op=>({key:op.key,path:op.path,activity:op.activity??ops.find(o=>o.key===op.key).activity,pdf:Buffer.from(`%PDF-1.7\n${op.path}`),attempts:1}));
    }};
    const evidenceService=new RunEvidenceService(db,portal);
    const controller=new AutoSnapController(db,null,portal,null,evidenceService);
    controller.user=async()=>({id:owner,role:"admin"});controller.enforceRateLimit=async()=>{};
    const action=async(name,input={})=>{const res={code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};}};return controller.action({body:{action:name,...input},headers:{}},res);};
    const promoted=await action("retryAspiEvidence",{id:runId,userId:"retry-user"});
    assert.equal(promoted.status,200,JSON.stringify(promoted.body));assert.equal(promoted.body.status,"PASSED");assert.equal(downloads,1);
    const saved=await db.one("SELECT status,request_json FROM autosnap_runs WHERE id=$1",[runId]);
    assert.equal(saved.status,"PASSED");
    assert.equal(saved.request_json.progressLog.some(item=>item.detail==="awal"),true);
    assert.equal(saved.request_json.reprocessAudit[0].statusBefore,"COMPLETED");
    assert.equal(saved.request_json.reprocessAudit[0].statusAfter,"PASSED");
    assert.equal(saved.request_json.checkpoint.stages.find(stage=>stage.id==="evidence").status,"COMPLETED");
    assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM autosnap_evidence_pdfs WHERE run_id=$1",[runId])).n,4);

    const failedId=randomUUID();
    const failedEval={...evaluation,outcome:"FAILED",detail:"HTTP 500 tidak sesuai expected 200.",httpValidation:{...evaluation.httpValidation,actualStatus:500,matches:false}};
    const failedCheckpoint={version:1,stages:[{id:"evaluation",status:"FAILED",at:now,detail:"HTTP 500"},{id:"evidence",status:"FAILED",at:now},{id:"finished",status:"COMPLETED",at:now}]};
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,mode,status,http_status,response_code,expected_code,duration_ms,notes,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','retry-user','s','ep','portal','FAILED',500,'5001100',null,10,'failed',$3::jsonb,'{}'::jsonb,$4)",[failedId,owner,JSON.stringify({evaluation:failedEval,evidence,outcome:"FAILED",checkpoint:failedCheckpoint,progressLog:[{stage:"evaluation",status:"failed",detail:"http gagal",at:now}]}),now]);
    const kept=await action("retryAspiEvidence",{id:failedId,userId:"retry-user"});
    assert.equal(kept.status,200,JSON.stringify(kept.body));assert.equal(kept.body.status,"FAILED");
    const failedRow=await db.one("SELECT status,request_json FROM autosnap_runs WHERE id=$1",[failedId]);
    assert.equal(failedRow.status,"FAILED");
    assert.equal(failedRow.request_json.checkpoint.stages.find(stage=>stage.id==="evaluation").status,"FAILED");
    assert.equal(failedRow.request_json.checkpoint.stages.find(stage=>stage.id==="evidence").status,"COMPLETED");
    assert.equal(failedRow.request_json.progressLog.some(item=>item.detail==="http gagal"),true);
    assert.match(failedRow.request_json.reprocessAudit[0].priorDetail,/HTTP 500/);
    assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM autosnap_evidence_pdfs WHERE run_id=$1",[failedId])).n,4);
  }finally{await db.onModuleDestroy();}
});

test("resumeTesting requires confirmMutatingRetry for POST when target HTTP never returned",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const owner=await createAccount(db,{username:"resume-owner",email:"resume@example.test",password:"resume-password-123"},"admin",true);
    const now=new Date().toISOString();
    const checkpoint={version:1,stages:[{id:"preparing",status:"COMPLETED",at:now},{id:"signature_auth",status:"COMPLETED",at:now},{id:"access_token",status:"COMPLETED",at:now},{id:"signature_service",status:"COMPLETED",at:now},{id:"api_request",status:"FAILED",at:now,error:"timeout"},{id:"evaluation",status:"FAILED",at:now},{id:"evidence",status:"PENDING",at:now},{id:"finished",status:"FAILED",at:now}]};
    const runId=randomUUID();
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,mode,status,http_status,response_code,expected_code,duration_ms,notes,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','u','s','ep','portal','AUTOMATION_ERROR',null,null,null,10,'no http',$3::jsonb,'{}'::jsonb,$4)",[runId,owner,JSON.stringify({checkpoint,outcome:"AUTOMATION_ERROR",method:"POST",path:"/api/v1.0/balance-inquiry",progressLog:[]}),now]);
    const controller=new AutoSnapController(db,null,null,null,new RunEvidenceService(db,null));
    controller.user=async()=>({id:owner,role:"admin"});controller.enforceRateLimit=async()=>{};
    const action=async(name,input={})=>{const res={code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};}};return controller.action({body:{action:name,...input},headers:{}},res);};
    const blocked=await action("resumeTesting",{id:runId});
    assert.equal(blocked.status,409);assert.match(String(blocked.body.error??blocked.body.message??JSON.stringify(blocked.body)),/confirmMutatingRetry/i);
  }finally{await db.onModuleDestroy();}
});

test("AutoSNAP report PDF download action is removed",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const owner=await createAccount(db,{username:"report-gone",email:"report-gone@example.test",password:"report-password-123"},"admin",true);
    const controller=new AutoSnapController(db,null,null,null,new RunEvidenceService(db,null));
    controller.user=async()=>({id:owner,role:"admin"});controller.enforceRateLimit=async()=>{};
    const res={code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};}};
    const result=await controller.action({body:{action:"downloadTestReportPdf",id:randomUUID()},headers:{}},res);
    assert.ok(result.status>=400);assert.notEqual(result.status,200);
  }finally{await db.onModuleDestroy();}
});

test("active evidence lease reports PROCESSING, stored PDFs reconcile, and a stale lease can be retried",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const {sha256}=require("../backend/dist/security.js");
    const {encrypt}=require("../backend/dist/security.js");
    const owner=await createAccount(db,{username:"lease-owner",email:"lease@example.test",password:"lease-password-123"},"admin",true);
    const now=new Date().toISOString();
    await db.query("INSERT INTO autosnap_records(id,kind,name,data,created_at,updated_at) VALUES('lease-user','snap_user','QA',$1::jsonb,$2,$2)",[JSON.stringify({email:"qa@example.test",password:encrypt("fixture")}),now]);
    const paths=["/api/v1.0/balance-inquiry"];
    const ops=paths.map((path,i)=>({key:`op-${i}`,path,service:path,attempts:0,pdfReady:false,activity:{activityId:`aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee${i}`,service:path,timestamp:now,downloadUrl:"https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity"}}));
    const evaluation={mode:"HTTP_ONLY",snapValidationPerformed:false,outcome:"COMPLETED",stage:"evaluation",stageLabel:"Validasi HTTP",detail:"HTTP 200 sesuai expected 200. Pengumpulan bukti PDF belum selesai.",suggestion:"",httpValidation:{expectedStatus:200,actualStatus:200,performed:true,matches:true,source:"target_api"}};
    const evidence={version:1,phase:"INCOMPLETE",retryCount:0,accountHash:sha256("qa@example.test"),beforeIds:[],operations:ops};
    const insert=async(id,status="COMPLETED")=>db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,mode,status,http_status,response_code,expected_code,duration_ms,notes,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','lease-user','s','ep','portal',$5,200,'2001100',null,10,'open',$3::jsonb,'{}'::jsonb,$4)",[id,owner,JSON.stringify({evaluation,evidence,outcome:status,progressLog:[{stage:"evidence",status:"failed",detail:"awal",at:now}]}),now,status]);
    let downloads=0;
    const portal={collectEvidence:async input=>{downloads++;return input.operations.map(op=>({key:op.key,path:op.path,activity:op.activity,pdf:Buffer.from(`%PDF-1.7\n${op.path}`),attempts:1}));}};
    const controller=new AutoSnapController(db,null,portal,null,new RunEvidenceService(db,portal));
    controller.user=async()=>({id:owner,role:"admin"});controller.enforceRateLimit=async()=>{};
    const action=async(name,input={})=>{const res={code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};}};return controller.action({body:{action:name,...input},headers:{}},res);};
    const busyId=randomUUID();
    await insert(busyId);
    const fresh=new Date(Date.now()+10*60_000).toISOString();
    await db.query("INSERT INTO autosnap_automation_leases(key,owner,expires_at,heartbeat_at) VALUES($1,'other',$2,$3)",[`evidence:${busyId}`,fresh,new Date().toISOString()]);
    const busy=await action("retryAspiEvidence",{id:busyId});
    assert.equal(busy.status,200,JSON.stringify(busy.body));
    assert.equal(busy.body.processing,true);
    assert.equal(busy.body.status,"PROCESSING");
    assert.equal(downloads,0);
    assert.equal((await db.one("SELECT status FROM autosnap_runs WHERE id=$1",[busyId])).status,"COMPLETED");

    const doneId=randomUUID();
    await insert(doneId);
    await db.query("INSERT INTO autosnap_automation_leases(key,owner,expires_at,heartbeat_at) VALUES($1,'other',$2,$3)",[`evidence:${doneId}`,fresh,new Date().toISOString()]);
    await db.query("INSERT INTO autosnap_evidence_pdfs(run_id,activity_id,service,pdf_data,byte_size,created_at) VALUES($1,$2,'balance',$3,12,$4)",[doneId,ops[0].activity.activityId,Buffer.from("%PDF-1.7\nstored"),now]);
    const reconciled=await action("retryAspiEvidence",{id:doneId});
    assert.equal(reconciled.status,200,JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.status,"PASSED");
    assert.equal(downloads,0);
    const reconciledRow=await db.one("SELECT status,request_json FROM autosnap_runs WHERE id=$1",[doneId]);
    assert.equal(reconciledRow.status,"PASSED");
    assert.equal(reconciledRow.request_json.progressLog.some(item=>item.detail==="awal"),true);

    const staleId=randomUUID();
    await insert(staleId);
    await db.query("INSERT INTO autosnap_automation_leases(key,owner,expires_at,heartbeat_at) VALUES($1,'dead',$2,$3)",[`evidence:${staleId}`,fresh,new Date(Date.now()-10*60_000).toISOString()]);
    const retried=await action("retryAspiEvidence",{id:staleId});
    assert.equal(retried.status,200,JSON.stringify(retried.body));
    assert.equal(retried.body.status,"PASSED");
    assert.equal(downloads,1);
    assert.equal(await db.one("SELECT owner FROM autosnap_automation_leases WHERE key=$1",[`evidence:${staleId}`]),null);
  }finally{await db.onModuleDestroy();}
});

test("partial PDF reprocessing stays COMPLETED and lists the missing evidence",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const {sha256,encrypt}=require("../backend/dist/security.js");
    const owner=await createAccount(db,{username:"partial-owner",email:"partial@example.test",password:"partial-password-123"},"admin",true);
    const now=new Date().toISOString();
    await db.query("INSERT INTO autosnap_records(id,kind,name,data,created_at,updated_at) VALUES('partial-user','snap_user','QA',$1::jsonb,$2,$2)",[JSON.stringify({email:"qa@example.test",password:encrypt("fixture")}),now]);
    const paths=["/api/v1.0/utilities/signature-auth","/api/v1.0/balance-inquiry"];
    const ops=paths.map((path,i)=>({key:`op-${i}`,path,service:path,attempts:0,pdfReady:false,activity:{activityId:`aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee${i}`,service:path,timestamp:now,downloadUrl:"https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity"}}));
    const evaluation={mode:"HTTP_ONLY",snapValidationPerformed:false,outcome:"COMPLETED",stage:"evaluation",stageLabel:"Validasi HTTP",detail:"HTTP 200 sesuai expected 200. Pengumpulan bukti PDF belum selesai.",suggestion:"",httpValidation:{expectedStatus:200,actualStatus:200,performed:true,matches:true,source:"target_api"}};
    const evidence={version:1,phase:"INCOMPLETE",retryCount:1,accountHash:sha256("qa@example.test"),beforeIds:[],operations:ops};
    const runId=randomUUID();
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,mode,status,http_status,response_code,expected_code,duration_ms,notes,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','partial-user','s','ep','portal','COMPLETED',200,'2001100',null,10,'partial',$3::jsonb,'{}'::jsonb,$4)",[runId,owner,JSON.stringify({evaluation,evidence,outcome:"COMPLETED",progressLog:[{stage:"evidence",status:"failed",detail:"awal",at:now}],reprocessAudit:[{at:now,stage:"pdf_reprocessing",priorStatus:"COMPLETED",result:"INCOMPLETE",note:"percobaan lama"}]}),now]);
    const portal={collectEvidence:async input=>input.operations.map(op=>op.key==="op-0"?{key:op.key,path:op.path,activity:op.activity,pdf:Buffer.from(`%PDF-1.7\n${op.path}`),attempts:1}:{key:op.key,path:op.path,error:"PDF belum tersedia",attempts:1})};
    const controller=new AutoSnapController(db,null,portal,null,new RunEvidenceService(db,portal));
    controller.user=async()=>({id:owner,role:"admin"});controller.enforceRateLimit=async()=>{};
    const res={code:200,status(c){this.code=c;return this;},json(body){return {status:this.code,body};}};
    const result=await controller.action({body:{action:"retryAspiEvidence",id:runId},headers:{}},res);
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.status,"COMPLETED");
    assert.equal(result.body.stored,1);
    assert.equal(result.body.missing.length,1);
    const row=await db.one("SELECT status,request_json FROM autosnap_runs WHERE id=$1",[runId]);
    assert.equal(row.status,"COMPLETED");
    assert.equal(row.request_json.progressLog.some(item=>item.detail==="awal"),true);
    assert.equal(row.request_json.reprocessAudit.some(item=>item.note==="percobaan lama"),true);
    assert.equal(row.request_json.reprocessAudit.at(-1).result,"INCOMPLETE");
    assert.equal(row.request_json.evidenceErrors.length,1);
  }finally{await db.onModuleDestroy();}
});
