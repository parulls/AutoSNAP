import assert from "node:assert/strict";
import test from "node:test";
import {configureBalanceExpectation} from "./balance-expectation-fixture.mjs";
import {createRequire} from "node:module";
import {randomBytes} from "node:crypto";
const require=createRequire(import.meta.url);
const {DatabaseService}=require("../backend/dist/database.service.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {createAccount}=require("../backend/dist/accounts.js");
const {saveConnection}=require("../backend/dist/connection.js");
const {encrypt}=require("../backend/dist/security.js");
const paths=["/api/v1.0/utilities/signature-auth","/api/v1.0/access-token/b2b","/api/v1.0/utilities/signature-service","/api/v1.0/balance-inquiry"];

test("History is saved before PDF collection; only Passed scenarios download, including expected negative rejection",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  await configureBalanceExpectation(db);
  try{
    const owner=await createAccount(db,{username:"pdf-owner",email:"pdf-owner@example.test",password:"test-password-123"},"admin",true),operator={id:owner,role:"admin"};
    const now=new Date().toISOString();
    await db.query("INSERT INTO autosnap_records(id,kind,name,data,created_at,updated_at) VALUES('pdf-user','snap_user','QA',$1::jsonb,$2,$2)",[JSON.stringify({email:"qa@example.test",password:encrypt("fixture-password")}),now]);
    const connection=await saveConnection(db,{name:"PDF QA",userId:"pdf-user",client:{clientId:"pdf-client",clientSecret:"secret",privateKey:"private"},environment:{mode:"portal"}});
    let http=200,code="2001100",downloadCalls=0,downloadFails=false;
    const portal={hit:async args=>({status:http,outcome:http===200?"SUCCESS":"HTTP_ERROR",activityBaseline:[],body:{responseCode:code,responseMessage:"Actual test response"},request:{name:paths[3],body:args.body,steps:paths.slice(0,3).map(name=>({name,httpStatus:200}))}}),collectEvidence:async args=>{
      downloadCalls++;
      const run=await db.one("SELECT * FROM autosnap_runs ORDER BY created_at DESC LIMIT 1");
      assert.equal(run.status,"Passed");assert.equal(run.operator_id,owner);assert.deepEqual(args.paths,paths);
      const progress=await db.one("SELECT steps FROM autosnap_test_progress ORDER BY updated_at DESC LIMIT 1");
      assert.ok(progress.steps.some(item=>item.stage==="evaluation"&&item.status==="completed"));
      if(downloadFails)throw Error("ASPI download timeout");
      return paths.map((path,index)=>({path,activity:{activityId:`93f163ae-e2fc-4f2e-9a03-518094515b4${index}`,service:path,timestamp:now,downloadUrl:"https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity"},pdf:Buffer.from("%PDF-1.7\nASPI fixture")}));
    }};
    const controller=new AutoSnapController(db,null,portal);
    const input={clientId:connection.clientId,projectId:connection.projectId,environmentId:connection.id,userId:"pdf-user",serviceId:"seed-service-10",endpointId:"seed-endpoint-10",body:JSON.stringify({accountNo:"2000100101"})};
    const run=async(testType="positive")=>{const res={code:200,status(code){this.code=code;return this;},json(body){return {code:this.code,body};}};return controller.run(res,{...input,testType},operator);};
    let result=await run();assert.equal(result.code,200);assert.equal(result.body.status,"Passed");assert.equal(downloadCalls,1);
    const saved=await db.one("SELECT request_json FROM autosnap_runs WHERE id=$1",[result.body.id]);assert.equal(saved.request_json.aspiActivities.filter(item=>item.pdfReady).length,4);
    assert.equal((await db.one("SELECT COUNT(*)::int AS total FROM autosnap_evidence_pdfs WHERE run_id=$1",[result.body.id])).total,4);
    http=401;code="4011101";result=await run();assert.equal(result.body.status,"Failed");assert.equal(downloadCalls,1,"unexpected 401 must not download");
    result=await run("invalid_access_token");assert.equal(result.body.status,"Passed");assert.equal(downloadCalls,2,"expected negative 401 still qualifies as Passed");
    downloadFails=true;http=200;code="2001100";result=await run();assert.equal(result.body.status,"Passed");
    const failedPdf=await db.one("SELECT request_json FROM autosnap_runs WHERE id=$1",[result.body.id]);assert.equal(failedPdf.request_json.evidenceErrors.length,4);assert.ok(failedPdf.request_json.progressLog.some(item=>item.stage==="pdf_download"&&item.status==="failed"));
  }finally{await db.onModuleDestroy();}
});
