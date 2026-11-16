import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {existsSync} from "node:fs";
const require=createRequire(import.meta.url);
const {correlateActivity,fetchOfficialPdf,validateOfficialPdf}=require("../backend/dist/aspi-evidence.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {PortalEngine}=require("../backend/dist/portal-engine.js");
const {chromium}=require("playwright-core");
const chrome=[process.env.AUTOSNAP_CHROME_PATH,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(existsSync);
const activityId="93f163ae-e2fc-4f2e-9a03-518094515b49";
const activity={activityId,service:"API Balance Inquiry",timestamp:"2026-11-17",downloadUrl:`https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`};

test("PDF activity correlation rejects old, unrelated and ambiguous rows",()=>{
  assert.equal(correlateActivity(new Set(),[activity],"/api/v1.0/balance-inquiry"),activity);
  assert.equal(correlateActivity(new Set([activityId]),[activity],"/api/v1.0/balance-inquiry"),null);
  assert.equal(correlateActivity(new Set(),[activity],"/api/v1.0/access-token/b2b"),null);
  assert.equal(correlateActivity(new Set(),[activity,{...activity,activityId:"other"}],"/api/v1.0/balance-inquiry"),null);
});

test("official PDF download preserves original bytes and rejects HTML login/error pages",async()=>{
  const pdf=Buffer.from("%PDF-1.7\noriginal ASPI bytes"),responses=[];
  const page={context:()=>({request:{get:async(url,options)=>{responses.push({url,options});return {ok:()=>true,body:async()=>pdf,dispose:async()=>{}};}}})};
  assert.deepEqual(await fetchOfficialPdf(page,activity.downloadUrl),pdf);
  assert.equal(responses[0].options.maxRedirects,0);
  assert.throws(()=>validateOfficialPdf(Buffer.from("<html>Login</html>")),/tidak memberikan PDF/);
  await assert.rejects(fetchOfficialPdf(page,"https://evil.example/report"),/URL PDF/);
});

test("automation prefetches PDF in its current ASPI session and preserves Activity ID on download failure",async()=>{
  const engine=new PortalEngine(null,null),pdf=Buffer.from("%PDF-1.7\nASPI result");
  engine.activitiesInContext=async()=>[activity];
  let calls=0,valid=true;
  const page={waitForTimeout:async()=>{},context:()=>({request:{get:async()=>{calls++;return {ok:()=>true,body:async()=>valid?pdf:Buffer.from("<html>Login</html>"),dispose:async()=>{}};}}})};
  let result=await engine.collectActivityPdf(page,new Set(),"/api/v1.0/balance-inquiry");
  assert.equal(result.activityId,activityId);assert.deepEqual(result.evidencePdf.pdf,pdf);assert.equal(calls,1);
  valid=false;result=await engine.collectActivityPdf(page,new Set(),"/api/v1.0/balance-inquiry");
  assert.equal(result.evidencePdf.activityId,activityId);assert.equal(result.evidencePdf.pdf,undefined);assert.match(result.evidenceError,/3 percobaan/);assert.equal(calls,4);
});

test("printable ASPI report becomes PDF, while an HTML login form is rejected",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const context=await browser.newContext();let login=false;
    await context.route("https://apidevportal.aspi-indonesia.or.id/**",route=>route.fulfill({contentType:"text/html",body:login?'<form><input type="password"></form>':'<h1>ASPI Report</h1><h2>Request</h2><pre>{}</pre><h2>Response</h2><pre>{}</pre>'}));
    const session={request:{get:async()=>({ok:()=>true,headers:()=>({"content-type":"text/html"}),body:async()=>Buffer.from("<html>Report</html>"),dispose:async()=>{}})},newPage:()=>context.newPage()};
    const page={context:()=>session};
    const pdf=await fetchOfficialPdf(page,activity.downloadUrl);assert.equal(pdf.subarray(0,5).toString(),"%PDF-");
    login=true;await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl),/halaman login/);
  }finally{await browser.close();}
});

test("PDF and ZIP download use persisted bytes, isolate owners and never contact ASPI",async()=>{
  const pdf=Buffer.from("%PDF-1.7\nstored"),run={id:"run-a",operator_id:"user-a",request_json:{aspiActivities:[activity]}};
  let cached=true,networkCalls=0;
  const db={one:async(sql,params)=>sql.includes("FROM autosnap_runs")?(params[1]===run.operator_id?run:null):cached?{pdf_data:pdf}:null};
  const controller=new AutoSnapController(db,null,{downloadActivityPdf:async()=>{networkCalls++;throw Error("must not contact ASPI");}});
  const response=()=>({code:200,headers:{},status(code){this.code=code;return this;},setHeader(k,v){this.headers[k]=v;},send(body){this.body=body;return this;},json(body){this.body=body;return this;}});
  let res=response();await controller.downloadAspiActivityPdf(res,{id:run.id,activityId},{id:"user-a"});assert.deepEqual(res.body,pdf);assert.equal(res.headers["Content-Type"],"application/pdf");
  res=response();await controller.downloadAspiActivitiesZip(res,{id:run.id},{id:"user-a"});assert.equal(res.body.readUInt32LE(0),0x04034b50);assert.ok(res.body.includes(pdf));
  res=response();await controller.downloadAspiActivityPdf(res,{id:run.id,activityId},{id:"user-b"});assert.equal(res.code,404);
  res=response();await controller.downloadAspiActivitiesZip(res,{id:run.id},{id:"user-b"});assert.equal(res.code,404);
  cached=false;res=response();await controller.downloadAspiActivityPdf(res,{id:run.id,activityId},{id:"user-a"});assert.equal(res.code,409);
  assert.equal(networkCalls,0);
});
