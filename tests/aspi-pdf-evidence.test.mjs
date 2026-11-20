import {createRequire as __createRequireHttp} from "node:module";
const __requireHttp=__createRequireHttp(import.meta.url);
const {RunEvidenceService}=__requireHttp("../backend/dist/run-evidence.js");
import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {existsSync} from "node:fs";
const require=createRequire(import.meta.url);
const {correlateActivity,fetchOfficialPdf,validateOfficialPdf,validateAspiDownloadPdf,pdfEvidenceFingerprint,inspectPdfProvenance}=require("../backend/dist/aspi-evidence.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {PortalEngine}=require("../backend/dist/portal-engine.js");
const {collectActivityPdfs}=require("../backend/dist/aspi-pdf-batch.js");
const {chromium}=require("playwright-core");
const chrome=[process.env.AUTOSNAP_CHROME_PATH,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(existsSync);
const activityId="93f163ae-e2fc-4f2e-9a03-518094515b49";
const activity={activityId,service:"API Balance Inquiry",timestamp:"2026-11-17",downloadUrl:`https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`};
const aspiPdf=(body,creation="D:20260101000000+07'00'")=>Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Producer (jsPDF 0.0.0) /Creator (html2pdf.js) /CreationDate (${creation}) /ID [<AAA> <BBB>] >>\nendobj\n${body}\n%%EOF\n`);

test("PDF activity correlation rejects old, unrelated and ambiguous rows",()=>{
  assert.equal(correlateActivity(new Set(),[activity],"/api/v1.0/balance-inquiry"),activity);
  assert.equal(correlateActivity(new Set([activityId]),[activity],"/api/v1.0/balance-inquiry"),null);
  assert.equal(correlateActivity(new Set(),[activity],"/api/v1.0/access-token/b2b"),null);
  assert.equal(correlateActivity(new Set(),[activity,{...activity,activityId:"other"}],"/api/v1.0/balance-inquiry"),null);
});

test("Generate QR MPM activity label matches path aliases without picking latest row",()=>{
  const mpm={activityId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",service:"API Generate QR MPM",timestamp:"2026-11-20",downloadUrl:`https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`};
  const other={...mpm,activityId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",service:"API Balance Inquiry"};
  assert.equal(correlateActivity(new Set(),[other,mpm],"/api/v1.0/qr/qr-mpm-generate"),mpm);
  assert.equal(correlateActivity(new Set(),[mpm,{...mpm,activityId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}],"/api/v1.0/qr/qr-mpm-generate"),null);
});

test("official PDF download forbids request/browser transports and rejects HTML",async()=>{
  const page={context:()=>({request:{get:async()=>{throw Error("must not GET HTML shell");}},newPage:async()=>{throw Error("unused");}})};
  await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,undefined,"request"),/Transport 'request' dilarang|tidak membuat PDF/);
  await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,undefined,"browser"),/Transport 'browser' dilarang|tidak membuat PDF/);
  assert.throws(()=>validateOfficialPdf(Buffer.from("<html>Login</html>")),/tidak memberikan PDF|HTML/);
  assert.throws(()=>validateOfficialPdf(Buffer.from("%PDF-1.7\ntruncated")),/%%EOF/);
  await assert.rejects(fetchOfficialPdf(page,"https://evil.example/report"),/URL PDF/);
});

test("backend source never contains Playwright page.pdf or printToPDF generators",async()=>{
  const {readdirSync,readFileSync}=await import("node:fs");
  const {join}=await import("node:path");
  const root=join(process.cwd(),"backend","src");
  const files=readdirSync(root).filter(name=>name.endsWith(".ts"));
  for(const name of files){
    const code=readFileSync(join(root,name),"utf8").replace(/\/\*[\s\S]*?\*\//g,"").replace(/\/\/.*$/gm,"");
    assert.equal(/(?:page|report|frame)\s*\.\s*pdf\s*\(/.test(code),false,`${name} must not call page.pdf()`);
    assert.equal(/printToPDF\s*\(/.test(code),false,`${name} must not use printToPDF`);
    assert.equal(/emulateMedia\s*\(\s*\{\s*media\s*:\s*["']print["']/.test(code),false,`${name} must not emulate print media for PDF`);
  }
});

test("stored PDF SHA-256 matches download bytes identically (no regenerate)",async()=>{
  const {createHash}=await import("node:crypto");
  const {pdfContentSha256}=require("../backend/dist/aspi-evidence.js");
  const pdf=aspiPdf("manual-aspi-bytes");
  const manualHash=createHash("sha256").update(pdf).digest("hex");
  assert.equal(pdfContentSha256(pdf),manualHash);
  const run={id:"run-hash",operator_id:"user-a",request_json:{aspiActivities:[activity]}};
  const db={one:async(sql)=>sql.includes("FROM autosnap_runs")?run:{pdf_data:pdf,content_sha256:manualHash,byte_size:pdf.length},query:async()=>{}};
  const controller=new AutoSnapController(db,null,{downloadActivityPdf:async()=>{throw Error("must not contact ASPI");}},null,new RunEvidenceService(db,null));
  const res={code:200,headers:{},status(code){this.code=code;return this;},setHeader(k,v){this.headers[k]=v;},send(body){this.body=body;return this;},json(body){this.body=body;return this;}};
  await controller.downloadAspiActivityPdf(res,{id:run.id,activityId},{id:"user-a",role:"petugas"});
  assert.deepEqual(res.body,pdf);
  assert.equal(res.headers["X-Content-SHA256"],manualHash);
  assert.equal(res.headers["X-Content-Fingerprint"],pdfEvidenceFingerprint(pdf));
  assert.equal(createHash("sha256").update(res.body).digest("hex"),manualHash);
});

test("ASPI html2pdf fingerprint matches across CreationDate; Chromium print rejected",()=>{
  const a=aspiPdf("same-body", "D:20261120120000+07'00'");
  const b=aspiPdf("same-body", "D:20261120125959+07'00'");
  assert.notEqual(require("node:crypto").createHash("sha256").update(a).digest("hex"),require("node:crypto").createHash("sha256").update(b).digest("hex"));
  assert.equal(pdfEvidenceFingerprint(a),pdfEvidenceFingerprint(b));
  assert.equal(inspectPdfProvenance(a).fromAspHtml2Pdf,true);
  validateAspiDownloadPdf(a);
  const chrome=Buffer.from("%PDF-1.7\n<< /Producer (Skia/PDF m124) /Creator (Chrome) >>\nbody\n%%EOF\n");
  assert.throws(()=>validateAspiDownloadPdf(chrome),/print\/render browser|bukan tombol Download/);
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
    try{await new Promise(resolve=>setTimeout(resolve,5));if(row.service==="Signature Service")throw Error("timeout");return Buffer.from("%PDF-1.7\nASPI result\n%%EOF\n");}finally{active--;}
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
  result=await collectActivityPdfs({...input,before:[activityId],deadline:Date.now()+8000});
  assert.match(result[0].error,/unik|ACTIVITY_NOT_FOUND/);
  assert.ok(calls>=1&&calls<=5);
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

test("HTML report without Download blob fails — AutoSNAP does not fabricate PDF",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const context=await browser.newContext({acceptDownloads:true});
    await context.route("https://apidevportal.aspi-indonesia.or.id/**",route=>{
      if(route.request().url().includes("downloadreportactivity")){
        return route.fulfill({contentType:"text/html",body:"<html><body><h1>ASPI Report</h1><form><input type='password'></form></body></html>"});
      }
      return route.fulfill({contentType:"text/html",body:"<h1>Activity</h1>"});
    });
    const page=await context.newPage();
    await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian");
    await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,Date.now()+4000,"navigation"),/login|HTML|blob PDF|pengganti|Timeout/i);
  }finally{await browser.close();}
});

test("request/browser transports remain forbidden for audit evidence",async()=>{
  const page={context:()=>({})};
  await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,Date.now()+1000,"browser"),/dilarang/);
  await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,Date.now()+1000,"request"),/dilarang/);
});

test("PDF and ZIP download use persisted bytes, isolate owners and never contact ASPI",async()=>{
  const pdf=aspiPdf("stored"),run={id:"run-a",operator_id:"user-a",request_json:{aspiActivities:[activity]}};
  let cached=true,networkCalls=0;
  const db={one:async(sql,params)=>sql.includes("FROM autosnap_runs")?(params[0]===run.id?run:null):cached?{pdf_data:pdf,content_sha256:null,byte_size:pdf.length}:null,query:async()=>{}};
  const controller=new AutoSnapController(db, null, {downloadActivityPdf:async()=>{networkCalls++;throw Error("must not contact ASPI");}}, null, new RunEvidenceService(db, null));
  const response=()=>({code:200,headers:{},status(code){this.code=code;return this;},setHeader(k,v){this.headers[k]=v;},send(body){this.body=body;return this;},json(body){this.body=body;return this;}});
  let res=response();await controller.downloadAspiActivityPdf(res,{id:run.id,activityId},{id:"user-a",role:"petugas"});assert.deepEqual(res.body,pdf);assert.equal(res.headers["Content-Type"],"application/pdf");
  res=response();await controller.downloadAspiActivitiesZip(res,{id:run.id},{id:"user-a",role:"petugas"});assert.equal(res.body.readUInt32LE(0),0x04034b50);assert.ok(res.body.includes(pdf));
  res=response();await controller.downloadAspiActivityPdf(res,{id:run.id,activityId},{id:"user-b",role:"petugas"});assert.equal(res.code,404);
  res=response();await controller.downloadAspiActivitiesZip(res,{id:run.id},{id:"user-b",role:"petugas"});assert.equal(res.code,404);
  cached=false;res=response();await controller.downloadAspiActivityPdf(res,{id:run.id,activityId},{id:"user-a",role:"petugas"});assert.equal(res.code,409);
  assert.equal(networkCalls,0);
});

test("native navigation saves an attachment and rejects a redirected login page",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const context=await browser.newContext({acceptDownloads:true}),pdf=aspiPdf("Official ASPI attachment");let mode="attachment",calls=0;
    const blobHtml=`<!DOCTYPE html><html><body><div id="printPdf">report</div><script>
      window.html2pdf=function(){};
      const bytes=Uint8Array.from(atob("${pdf.toString("base64")}"),c=>c.charCodeAt(0));
      const a=document.createElement("a");
      a.href=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
      a.download="Signature Authentication.pdf";
      a.click();
    </script></body></html>`;
    await context.route("https://apidevportal.aspi-indonesia.or.id/**",route=>{
      if(!route.request().url().includes("downloadreportactivity"))return route.fulfill({contentType:"text/html",body:"<h1>Activity</h1>"});
      calls++;
      if(mode==="login")return route.fulfill({contentType:"text/html",body:'<form><input type="password"></form>'});
      if(mode==="html")return route.fulfill({contentType:"text/html",body:"<h1>ASPI Report</h1><h2>Request</h2><pre>{}</pre><h2>Response</h2><pre>{}</pre>"});
      if(mode==="html-blob")return route.fulfill({contentType:"text/html; charset=utf-8",body:blobHtml});
      return route.fulfill({contentType:"application/pdf",headers:{"content-disposition":'attachment; filename="ASPI.pdf"'},body:pdf});
    });
    const page=await context.newPage();await page.goto("https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian");
    assert.deepEqual(await fetchOfficialPdf(page,activity.downloadUrl,Date.now()+5000,"navigation"),pdf);assert.equal(calls,1);
    mode="html-blob";assert.deepEqual(await fetchOfficialPdf(page,activity.downloadUrl,Date.now()+8000,"navigation"),pdf);
    mode="html";await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,Date.now()+4000,"navigation"),/HTML|html2pdf|Timeout|blob PDF/);
    mode="login";await assert.rejects(fetchOfficialPdf(page,activity.downloadUrl,Date.now()+5000,"navigation"),/halaman login|PDF resmi/);
    assert.equal(context.pages().length,1,"report tabs are closed after success and failure");
  }finally{await browser.close();}
});
