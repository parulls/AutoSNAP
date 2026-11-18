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
  assert.equal(canRetryEvidence({status:"FAILED",httpMatched:false,evidenceIncomplete:true}),false);
  assert.equal(canResumeTesting({status:"AUTOMATION_ERROR",hasTargetHttp:false,failedStageId:"access_token"}),true);
  assert.equal(canResumeTesting({status:"FAILED",hasTargetHttp:true,failedStageId:"evaluation"}),false);
  assert.equal(requiresMutatingConfirm("POST",false,true),true);
  assert.equal(requiresMutatingConfirm("GET",false,true),false);
  assert.equal(requiresMutatingConfirm("POST",true,true),false);
});

test("retryAspiEvidence promotes COMPLETED to PASSED; FAILED HTTP refuses promotion",async()=>{
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
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,mode,status,http_status,response_code,expected_code,duration_ms,notes,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','retry-user','s','ep','portal','COMPLETED',200,'2001100',null,10,'incomplete',$3::jsonb,'{}'::jsonb,$4)",[runId,owner,JSON.stringify({evaluation,evidence,outcome:"COMPLETED",progressLog:[]}),now]);
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
    assert.equal((await db.one("SELECT status FROM autosnap_runs WHERE id=$1",[runId])).status,"PASSED");
    assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM autosnap_evidence_pdfs WHERE run_id=$1",[runId])).n,4);

    const failedId=randomUUID();
    const failedEval={...evaluation,outcome:"FAILED",detail:"HTTP 500 tidak sesuai expected 200.",httpValidation:{...evaluation.httpValidation,actualStatus:500,matches:false}};
    await db.query("INSERT INTO autosnap_runs(id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,mode,status,http_status,response_code,expected_code,duration_ms,notes,request_json,response_json,created_at) VALUES($1,$2,'c','p','e','retry-user','s','ep','portal','FAILED',500,'5001100',null,10,'failed',$3::jsonb,'{}'::jsonb,$4)",[failedId,owner,JSON.stringify({evaluation:failedEval,evidence,outcome:"FAILED",progressLog:[]}),now]);
    const refused=await action("retryAspiEvidence",{id:failedId,userId:"retry-user"});
    assert.equal(refused.status,409);assert.equal((await db.one("SELECT status FROM autosnap_runs WHERE id=$1",[failedId])).status,"FAILED");
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
