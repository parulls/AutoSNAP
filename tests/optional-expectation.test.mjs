import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {randomBytes,randomUUID} from "node:crypto";
const require=createRequire(import.meta.url);
const {evaluateTest,notEvaluatedMessage}=require("../backend/dist/test-evaluation.js");
const {validateConfig}=require("../backend/dist/endpoint-config.js");
const {scenarioExpectation}=require("../backend/dist/endpoint-resolver.js");
const {DatabaseService}=require("../backend/dist/database.service.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {createAccount}=require("../backend/dist/accounts.js");
const {saveConnection}=require("../backend/dist/connection.js");
const {encrypt}=require("../backend/dist/security.js");
const {readHistory}=require("../backend/dist/history.js");

const url="https://apidevportal.aspi-indonesia.or.id/api-services/riwayat-transaksi#/TransactionHistory/post_api_v1_0_bank_statement";
const config={version:1,sourceUrl:url,operationId:"post_api_v1_0_bank_statement",identity:{method:"POST",path:"/api/v1.0/bank-statement"},reviewed:true,authFlow:"b2b",requestSchema:{type:"object",required:["accountNo","fromDateTime"],properties:{accountNo:{type:"string"},fromDateTime:{type:"string"}}},parameters:[],warnings:[],responses:{200:{schema:{type:"object",required:["responseCode","responseMessage"]}}},expectedHttpStatus:200,expectedCode:null};

test("blank/missing expected code is optional and legacy paths never invent expected codes",()=>{
  for(const expectedCode of [undefined,null,"","   "]){
    const normalized=validateConfig({...config,expectedCode});assert.equal(normalized.expectedCode,null);
    assert.equal(scenarioExpectation(normalized,false,false).expectedCode,null);
  }
  assert.deepEqual(scenarioExpectation(null,true,false),{expectedHttpStatus:200,expectedCode:null});
  assert.deepEqual(scenarioExpectation(null,true,true),{expectedHttpStatus:401,expectedCode:null});
  assert.equal(validateConfig({...config,expectedCode:" 2001400 "}).expectedCode,"2001400");
  assert.throws(()=>validateConfig({...config,expectedCode:"wrong"}),/tujuh digit/);
});

test("missing expected code never yields Passed/Failed from an HTTP response alone",()=>{
  for(const [httpStatus,actualCode] of [[200,"2001400"],[401,"4011401"],[500,null]]){
    const result=evaluateTest({httpStatus,actualCode,expectedCode:null,checks:[{label:"HTTP",passed:httpStatus===200,detail:"Observed HTTP"}],cancelled:false});
    assert.equal(result.status,"NOT_EVALUATED");assert.equal(result.evaluation.outcome,"NOT_EVALUATED");assert.equal(result.evaluation.stageLabel,"Validasi Hasil");assert.equal(result.evaluation.detail,notEvaluatedMessage.detail);assert.equal(result.evaluation.suggestion,notEvaluatedMessage.suggestion);
  }
  const base={httpStatus:200,actualCode:"2001400",expectedCode:"2001400",checks:[],cancelled:false};
  assert.equal(evaluateTest(base).evaluation.outcome,"PASSED");
  assert.equal(evaluateTest({...base,actualCode:"4001400"}).evaluation.outcome,"FAILED");
  assert.equal(evaluateTest({...base,checks:[{label:"Response schema",passed:false,detail:"Missing field"}]}).status,"Failed");
  assert.equal(evaluateTest({...base,httpStatus:401,actualCode:"4011401",expectedCode:"4011401"}).status,"Passed");
  for(const httpStatus of [null,0])assert.equal(evaluateTest({...base,httpStatus,expectedCode:null}).evaluation.outcome,"NOT_EXECUTED");
  assert.equal(evaluateTest({...base,expectedCode:null,cancelled:true}).status,"Cancelled");
});

test("controller executes without expected, persists actual response/progress and counts NOT_EVALUATED separately",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const owner=await createAccount(db,{username:"optional-owner",email:"optional@example.test",password:"optional-password-123"},"admin",true),now=new Date().toISOString();
    await db.query("INSERT INTO autosnap_records(id,kind,name,data,created_at,updated_at) VALUES('optional-user','snap_user','QA',$1::jsonb,$2,$2)",[JSON.stringify({email:"qa@example.test",password:encrypt("fixture")}),now]);
    const connection=await saveConnection(db,{name:"Optional expected fixture",userId:"optional-user",client:{clientId:"optional-client",clientSecret:"secret",privateKey:"private"},environment:{mode:"portal"}});
    let calls=0,httpStatus=200,code="2001400",networkFailure=false;
    const portal={hit:async input=>{calls++;assert.equal(input.path,"/api/v1.0/bank-statement");assert.equal(input.method,"POST");assert.equal(input.user.id,"optional-user");return {status:networkFailure?null:httpStatus,outcome:networkFailure?"AUTH_SESSION_EXPIRED":httpStatus===200?"SUCCESS":"HTTP_ERROR",body:networkFailure?{error:"Session fixture expired"}:{responseCode:code,responseMessage:"Actual fixture",accountNo:"2000200202"},request:{method:input.method,path:input.path,body:input.body,steps:[]}};},collectEvidence:async()=>[]};
    const controller=new AutoSnapController(db,null,portal);controller.user=async()=>({id:owner,role:"admin"});controller.enforceRateLimit=async()=>{};
    const action=async(action,input={})=>{const res={code:200,status(code){this.code=code;return this;},json(body){return {status:this.code,body};}};return controller.action({body:{action,...input},headers:{}},res);};
    const draft={name:"Bank Statement",module:"Riwayat Transaksi",code:"14",portalUrl:url,method:"POST",path:"/api/v1.0/bank-statement",requestBody:'{"accountNo":"2000200202","fromDateTime":"2020-01-01T00:00:00+07:00"}',config:{...config}};
    const saved=await action("saveImportedService",{draft});assert.equal(saved.status,200);
    const input={clientId:connection.clientId,projectId:connection.projectId,environmentId:connection.id,userId:"optional-user",endpointId:saved.body.endpointId,serviceId:saved.body.serviceId,body:draft.requestBody};
    const run=()=>action("run",{...input,progressId:randomUUID()});
    let result=await run();assert.equal(calls,1);assert.equal(result.status,200);assert.equal(result.body.status,"NOT_EVALUATED");assert.equal(result.body.outcome,"NOT_EVALUATED");assert.equal(result.body.executionOutcome,"SUCCESS");assert.equal(result.body.expectedCode,null);assert.equal(result.body.httpStatus,200);assert.equal(result.body.responseCode,"2001400");assert.equal(result.body.response.accountNo,"[REDACTED]");assert.equal(result.body.checks.find(check=>check.label==="SNAP responseCode").passed,null);
    const history=await db.one("SELECT * FROM autosnap_runs WHERE id=$1",[result.body.id]);assert.equal(history.expected_code,null);assert.equal(history.status,"NOT_EVALUATED");assert.equal(history.http_status,200);assert.equal(history.response_code,"2001400");assert.equal(history.request_json.outcome,"NOT_EVALUATED");assert.equal(history.request_json.evaluation.detail,notEvaluatedMessage.detail);assert.equal(history.response_json.responseMessage,"Actual fixture");
    assert.ok(history.request_json.progressLog.some(step=>step.stage==="evaluation"&&step.status==="not_evaluated"&&step.detail.includes("NOT_EVALUATED")));
    const progress=await action("getProgress",{id:result.body.progressId});assert.equal(progress.body.stage,"finished");assert.equal(progress.body.status,"not_evaluated");
    httpStatus=401;code="4011401";result=await action("run",{...input,progressId:randomUUID(),testType:"invalid_access_token"});assert.equal(result.body.status,"NOT_EVALUATED");assert.equal(result.body.outcome,"NOT_EVALUATED");assert.equal(result.body.httpStatus,401);assert.equal(result.body.responseCode,"4011401");
    networkFailure=true;result=await run();assert.equal(result.body.status,"Failed");assert.equal(result.body.outcome,"AUTH_SESSION_EXPIRED");assert.equal(result.body.evaluation.outcome,"NOT_EXECUTED");networkFailure=false;httpStatus=200;code="2001400";
    const before=calls;const invalid=await action("run",{...input,progressId:randomUUID(),body:"{broken"});assert.equal(invalid.status,400);assert.equal(calls,before);
    draft.config.expectedCode="2001400";await action("saveImportedService",{draft});result=await run();assert.equal(result.body.status,"Passed");assert.equal(result.body.evaluation.outcome,"PASSED");assert.equal(result.body.outcome,"PASSED");
    code="4001400";result=await run();assert.equal(result.body.status,"Failed");assert.equal(result.body.evaluation.outcome,"FAILED");assert.equal(result.body.outcome,"FAILED");
    const date=new Date(Date.now()+7*3600000).toISOString().slice(0,10),summary=(await readHistory(db,owner,{from:date,to:date})).summary;
    assert.equal(summary.notEvaluated,2);assert.equal(summary.passed,1);assert.equal(summary.failed,2);assert.equal(summary.errors,0);
  }finally{await db.onModuleDestroy();}
});
