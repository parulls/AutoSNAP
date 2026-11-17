import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {existsSync} from "node:fs";
const require=createRequire(import.meta.url);
const {correlateActivity,fetchOfficialPdf,validateOfficialPdf}=require("../backend/dist/aspi-evidence.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {PortalEngine}=require("../backend/dist/portal-engine.js");
const {collectActivityPdfs}=require("../backend/dist/aspi-pdf-batch.js");
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

test("PDF batch shares one activity lookup, limits concurrency and preserves IDs on download failure",async()=>{
  const originalConcurrency=process.env.AUTOSNAP_PDF_CONCURRENCY;
  process.env.AUTOSNAP_PDF_CONCURRENCY="2";
  const paths=["/api/v1.0/utilities/signature-auth","/api/v1.0/access-token/b2b","/api/v1.0/utilities/signature-service","/api/v1.0/balance-inquiry"];
  const names=["Signature Auth","Access Token B2B","Signature Service","Balance Inquiry"];
  const rows=names.map((service,index)=>({...activity,service,activityId:`activity-${index}`}));
  const attempts=new Map(),logs=[];let reads=0,active=0,max=0;
  const results=await collectActivityPdfs({before:[],paths,deadline:Date.now()+10000,read:async()=>{reads++;return rows;},download:async row=>{
    active++;max=Math.max(max,active);attempts.set(row.activityId,(attempts.get(row.activityId)??0)+1);
    try{await new Promise(resolve=>setTimeout(resolve,5));if(row.service==="Signature Service")throw Error("timeout");return Buffer.from("%PDF-1.7\nASPI result");}finally{active--;}
  },report:async(status,detail)=>logs.push({status,detail})});
  assert.equal(reads,1);assert.equal(max,2);assert.equal(results.filter(item=>item.pdf).length,3);
  assert.equal(results[2].activity.activityId,"activity-2");assert.match(results[2].error,/Batas waktu/);
  assert.equal(attempts.get("activity-2"),2);assert.ok(logs.some(item=>item.status==="failed"));
  if(originalConcurrency===undefined)delete process.env.AUTOSNAP_PDF_CONCURRENCY;else process.env.AUTOSNAP_PDF_CONCURRENCY=originalConcurrency;
});

test("PDF collection never guesses IDs, starts work past its budget, or downloads after cancellation",async()=>{
  let calls=0;
  const input={before:[],paths:["/api/v1.0/balance-inquiry"],deadline:Date.now()+10000,read:async()=>{calls++;return [activity];},download:async()=>{calls++;throw Error("must not download");},report:async()=>{}};
  const cancelled=new AbortController();cancelled.abort();
  let result=await collectActivityPdfs({...input,signal:cancelled.signal});assert.match(result[0].error,/dibatalkan/);assert.equal(calls,0);
  result=await collectActivityPdfs({...input,deadline:Date.now()-1});assert.match(result[0].error,/Batas waktu/);assert.equal(calls,0);
  result=await collectActivityPdfs({...input,before:undefined});assert.match(result[0].error,/tidak ditebak/);assert.equal(calls,0);
  result=await collectActivityPdfs({...input,before:[activityId]});assert.match(result[0].error,/unik/);assert.equal(calls,3);
});

test("headless hit executes all four APIs without fetching PDFs between calls",async()=>{
  const {randomBytes}=await import("node:crypto"),{encrypt}=require("../backend/dist/security.js");
  process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const events=[],portal=new PortalEngine({getAuthenticatedContext:async()=>({page:{},release:async()=>events.push("release")})},null);
  portal.activitiesInContext=async()=>{events.push("baseline");return [activity];};
  portal.collectEvidence=async()=>{throw Error("hit must not collect PDFs");};
  portal.execute=async(page,url,path)=>{events.push(path);return {status:200,body:path.endsWith("signature-auth")||path.endsWith("signature-service")?{signature:"fixture"}:path.endsWith("/b2b")?{accessToken:"fixture"}:{responseCode:"2001100",responseMessage:"Successful"},request:{name:path,httpStatus:200}};};
  const result=await portal.hit({portalUrl:activity.downloadUrl.replace("/sandboxactivity/downloadreportactivity", "/api-services/informasi-saldo"),method:"POST",path:"/api/v1.0/balance-inquiry",body:{accountNo:"2000100101"},client:{data:{clientId:"test",privateKey:encrypt("private"),clientSecret:encrypt("secret"),channelId:"95221"}},user:{data:{}},externalId:"test",extraHeaders:{}});
  assert.equal(result.status,200);assert.deepEqual(result.activityBaseline,[activityId]);
  assert.ok(result.evidenceSession,"testing hands the authenticated session to the evidence phase");
  await result.evidenceSession.release();
  assert.deepEqual(events,["baseline","/api/v1.0/utilities/signature-auth","/api/v1.0/access-token/b2b","/api/v1.0/utilities/signature-service","/api/v1.0/balance-inquiry","release"]);
  assert.equal(result.request.steps.length,3);assert.equal(JSON.stringify(result.request).includes("evidencePdf"),false);
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

test("headless evidence uses authenticated browser transport and preserves the official PDF bytes",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const context=await browser.newContext(),pdf=Buffer.from("%PDF-1.7\nASPI browser report");let reportRequests=0;
    await context.addCookies([{name:"ASPI-session",value:"fixture-session",url:"https://apidevportal.aspi-indonesia.or.id"}]);
    await context.route("https://apidevportal.aspi-indonesia.or.id/**",async route=>{
      if(route.request().url().includes("downloadreportactivity")){
        reportRequests++;assert.match(await route.request().headerValue("cookie"),/ASPI-session=fixture-session/);
        return route.fulfill({contentType:"application/pdf",body:pdf});
      }
      return route.fulfill({contentType:"text/html",body:"<h1>Activity</h1>"});
    });
    const page=await context.newPage();await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian");
    context.request.get=async()=>{throw Error("must not use Node transport for batch evidence");};
    assert.deepEqual(await fetchOfficialPdf(page,activity.downloadUrl,Date.now()+5000,"browser"),pdf);assert.equal(reportRequests,1);
    await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,Date.now()-1,"browser"),/Batas waktu/);
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

test("native navigation saves an attachment and rejects a redirected login page",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const context=await browser.newContext({acceptDownloads:true}),pdf=Buffer.from("%PDF-1.7\nOfficial ASPI attachment");let mode="attachment",calls=0;
    await context.route("https://apidevportal.aspi-indonesia.or.id/**",route=>{
      if(!route.request().url().includes("downloadreportactivity"))return route.fulfill({contentType:"text/html",body:"<h1>Activity</h1>"});
      calls++;
      if(mode==="login")return route.fulfill({contentType:"text/html",body:'<form><input type="password"></form>'});
      if(mode==="html")return route.fulfill({contentType:"text/html",body:"<h1>ASPI Report</h1><h2>Request</h2><pre>{}</pre><h2>Response</h2><pre>{}</pre>"});
      return route.fulfill({contentType:"application/pdf",headers:{"content-disposition":'attachment; filename="ASPI.pdf"'},body:pdf});
    });
    const page=await context.newPage();await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian");
    assert.deepEqual(await fetchOfficialPdf(page,activity.downloadUrl,Date.now()+5000,"navigation"),pdf);assert.equal(calls,1);
    mode="html";assert.equal((await fetchOfficialPdf(page,activity.downloadUrl,Date.now()+5000,"navigation")).subarray(0,5).toString(),"%PDF-");assert.equal(calls,2,"HTML report needs only one navigation");
    mode="login";await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,Date.now()+5000,"navigation"),/halaman login/);
    assert.equal(context.pages().length,1,"report tabs are closed after success and failure");
  }finally{await browser.close();}
});
