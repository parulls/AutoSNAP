import {aspiDownloadFixture} from "./aspi-download-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {randomBytes,randomUUID} from "node:crypto";
const require=createRequire(import.meta.url);
const {evaluateTest}=require("../backend/dist/test-evaluation.js");
const {DatabaseService}=require("../backend/dist/database.service.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {createAccount}=require("../backend/dist/accounts.js");
const {saveConnection}=require("../backend/dist/connection.js");
const {encrypt}=require("../backend/dist/security.js");
const {readHistory}=require("../backend/dist/history.js");
const {RunEvidenceService}=require("../backend/dist/run-evidence.js");

const url="https://apidevportal.aspi-indonesia.or.id/api-services/riwayat-transaksi#/BankStatement/post_api_v1_0_bank_statement";
const config={version:1,sourceUrl:url,operationId:"post_api_v1_0_bank_statement",identity:{method:"POST",path:"/api/v1.0/bank-statement"},authFlow:"b2b",expectedHttpStatus:200,expectedCode:null,negativeToken:{expectedHttpStatus:401,expectedCode:null},parameters:[],requestSchema:null,responses:{"200":{example:{responseCode:"2001400",responseMessage:"Actual fixture",accountNo:"2000200202"}}},reviewed:true,warnings:[]};

test("positive SNAP+HTTP and negative HTTP-only evaluation rules",()=>{
  assert.equal(evaluateTest({httpStatus:200,expectedHttpStatus:200,cancelled:false}).status,"COMPLETED");
  assert.equal(evaluateTest({httpStatus:200,expectedHttpStatus:200,cancelled:false}).evaluation.mode,"HTTP_ONLY");
  assert.equal(evaluateTest({httpStatus:401,expectedHttpStatus:401,negative:true,cancelled:false}).status,"COMPLETED");
  assert.equal(evaluateTest({httpStatus:401,expectedHttpStatus:401,negative:true,expectedCode:"4011401",cancelled:false}).evaluation.mode,"HTTP_ONLY");
  assert.equal(evaluateTest({httpStatus:500,expectedHttpStatus:200,cancelled:false}).status,"FAILED");
  assert.equal(evaluateTest({httpStatus:null,expectedHttpStatus:200,cancelled:false}).status,"AUTOMATION_ERROR");
  assert.equal(evaluateTest({httpStatus:200,expectedHttpStatus:200,cancelled:true}).status,"CANCELLED");
  const mismatch=evaluateTest({httpStatus:200,expectedHttpStatus:200,actualCode:"4001400",expectedCode:"2001400",cancelled:false});
  assert.equal(mismatch.status,"FAILED","SNAP mismatch must fail when expected SNAP is configured");
  assert.equal(mismatch.evaluation.mode,"SNAP_AND_HTTP");
  const missing=evaluateTest({httpStatus:200,expectedHttpStatus:200,actualCode:null,expectedCode:"2001400",cancelled:false});
  assert.equal(missing.status,"FAILED","missing Actual SNAP must not fall back to HTTP PASSED");
  const both=evaluateTest({httpStatus:200,expectedHttpStatus:200,actualCode:"2001400",expectedCode:"2001400",cancelled:false});
  assert.equal(both.status,"COMPLETED");assert.equal(both.evaluation.mode,"SNAP_AND_HTTP");
  const snapOkHttpBad=evaluateTest({httpStatus:500,expectedHttpStatus:200,actualCode:"2001400",expectedCode:"2001400",cancelled:false});
  assert.equal(snapOkHttpBad.status,"FAILED");
});

test("controller persists COMPLETED/PASSED without requiring SNAP expected codes",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const owner=await createAccount(db,{username:"optional-owner",email:"optional@example.test",password:"optional-password-123"},"admin",true),now=new Date().toISOString();
    await db.query("INSERT INTO autosnap_records(id,kind,name,data,created_at,updated_at) VALUES('optional-user','snap_user','QA',$1::jsonb,$2,$2)",[JSON.stringify({email:"qa@example.test",password:encrypt("fixture")}),now]);
    const connection=await saveConnection(db,{name:"Optional expected fixture",userId:"optional-user",client:{clientId:"optional-client",clientSecret:"secret",privateKey:"private"},environment:{mode:"portal"}});
    let calls=0,httpStatus=200,code="2001400",networkFailure=false;
    const portal={hit:async input=>{calls++;assert.equal(input.path,"/api/v1.0/bank-statement");return {status:networkFailure?null:httpStatus,outcome:networkFailure?"AUTH_SESSION_EXPIRED":httpStatus===200?"SUCCESS":"HTTP_ERROR",body:networkFailure?{error:"Session fixture expired"}:{responseCode:code,responseMessage:"Actual fixture",accountNo:"2000200202"},request:{method:input.method,path:input.path,body:input.body,steps:[{name:"/api/v1.0/utilities/signature-auth",method:"POST",httpStatus:200},{name:"/api/v1.0/access-token/b2b",method:"POST",httpStatus:200},{name:"/api/v1.0/utilities/signature-service",method:"POST",httpStatus:200}]},activityBaseline:[]};},collectEvidence:async input=>input.paths.map(path=>({path,activity:{activityId:randomUUID(),service:path,timestamp:now,downloadUrl:"https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity"},pdf:aspiDownloadFixture(path)}))};
    const evidence=new RunEvidenceService(db,portal);
    const controller=new AutoSnapController(db,null,portal,null,evidence);controller.user=async()=>({id:owner,role:"admin"});controller.enforceRateLimit=async()=>{};
    const action=async(action,input={})=>{const res={code:200,status(code){this.code=code;return this;},json(body){return {status:this.code,body};}};return controller.action({body:{action,...input},headers:{}},res);};
    const draft={name:"Bank Statement",module:"Riwayat Transaksi",code:"14",portalUrl:url,method:"POST",path:"/api/v1.0/bank-statement",requestBody:'{"accountNo":"2000200202","fromDateTime":"2020-01-01T00:00:00+07:00"}',config:{...config}};
    const saved=await action("saveImportedService",{draft});assert.equal(saved.status,200);
    const input={clientId:connection.clientId,projectId:connection.projectId,environmentId:connection.id,userId:"optional-user",endpointId:saved.body.endpointId,serviceId:saved.body.serviceId,body:draft.requestBody};
    const run=()=>action("run",{...input,progressId:randomUUID()});
    let result=await run();assert.equal(calls,1);assert.equal(result.status,200);assert.equal(result.body.status,"PASSED");assert.equal(result.body.httpStatus,200);
    assert.ok(result.body.pdfCounts.required>=1);assert.equal(result.body.pdfCounts.ready,result.body.pdfCounts.required);
    httpStatus=401;code="4011401";result=await action("run",{...input,progressId:randomUUID(),testType:"invalid_access_token"});assert.equal(result.body.status,"PASSED");assert.equal(result.body.httpStatus,401);
    networkFailure=true;result=await run();assert.equal(result.body.status,"AUTOMATION_ERROR");networkFailure=false;httpStatus=200;code="2001400";
    httpStatus=500;result=await run();assert.equal(result.body.status,"FAILED");
    const date=new Date(Date.now()+7*3600000).toISOString().slice(0,10),summary=(await readHistory(db,owner,{from:date,to:date})).summary;
    assert.ok(summary.passed>=2);assert.ok(summary.failed>=1);assert.ok(summary.errors>=1);
  }finally{await db.onModuleDestroy();}
});
