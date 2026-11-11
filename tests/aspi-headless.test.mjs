import assert from "node:assert/strict";
import test from "node:test";
import {existsSync} from "node:fs";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {chromium}=require("playwright-core");
const {AspiFormResolver}=require("../backend/dist/aspi-form-resolver.js");
const {AspiSessionManager}=require("../backend/dist/aspi-session-manager.js");
const {PortalEngine,classifyHttpOutcome,captureTargetResponse,aspiActivityDownloadUrl}=require("../backend/dist/portal-engine.js");
const {encrypt}=require("../backend/dist/security.js");
const chrome=[process.env.AUTOSNAP_CHROME_PATH,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(existsSync);
const swagger=(path="/api/v1.0/balance-inquiry")=>`<div class="opblock opblock-post is-open"><div class="opblock-summary"><span class="opblock-summary-method">POST</span><span class="opblock-summary-path">${path}</span></div><div class="opblock-body"><button class="try-out__btn" onclick="document.querySelectorAll('[data-edit]').forEach(x=>x.disabled=false)">Try it out</button><table><tr><td class="parameters-col_name">Content-Type * string (header)</td><td><input disabled placeholder="Content-Type - e.g application/json"></td></tr><tr><td class="parameters-col_name">X-TIMESTAMP * string (header)</td><td><input data-edit disabled placeholder="X-TIMESTAMP - e.g 2020-01-01T00:00:00+07:00"></td></tr><tr><td class="parameters-col_name">X-SIGNATURE * string (header)</td><td><input disabled placeholder="X-SIGNATURE"></td></tr></table><textarea data-edit class="body-param__text" disabled></textarea><button>Execute</button></div></div>`;

test("ASPI activity PDF URL accepts only a UUID on the fixed ASPI host",()=>{
  const id="93f163ae-e2fc-4f2e-9a03-518094515b49";
  assert.equal(aspiActivityDownloadUrl(id),`https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${id}`);
  assert.throws(()=>aspiActivityDownloadUrl("../other-user"),/tidak valid/i);
});

test("ASPI PDF cache coalesces downloads and isolates SNAP accounts",async()=>{
  const engine=new PortalEngine(null,null),activityId="93f163ae-e2fc-4f2e-9a03-518094515b49";
  let renders=0;
  engine.renderActivityPdf=async()=>{renders++;await new Promise(resolve=>setTimeout(resolve,10));return Buffer.from("%PDF-test");};
  const [first,second]=await Promise.all([engine.downloadActivityPdf({id:"one"},activityId),engine.downloadActivityPdf({id:"one"},activityId)]);
  assert.deepEqual(first,second);assert.equal(renders,1);
  await engine.downloadActivityPdf({id:"one"},activityId);assert.equal(renders,1);
  await engine.downloadActivityPdf({id:"two"},activityId);assert.equal(renders,2);
});

test("ASPI PDF failed renders can be retried without caching the failure",async()=>{
  const engine=new PortalEngine(null,null),activityId="93f163ae-e2fc-4f2e-9a03-518094515b49";
  let renders=0;
  engine.renderActivityPdf=async()=>{if(++renders===1)throw Error("temporary failure");return Buffer.from("%PDF-test");};
  await assert.rejects(engine.downloadActivityPdf({id:"one"},activityId),/temporary failure/);
  await engine.downloadActivityPdf({id:"one"},activityId);assert.equal(renders,2);
});

test("ASPI resolver selects endpoint semantically, activates Try it out and skips Swagger-managed Content-Type",{skip:!chrome},async()=>{const browser=await chromium.launch({executablePath:chrome,headless:true});try{const page=await browser.newPage();await page.setContent(swagger("/wrong")+swagger());const resolver=new AspiFormResolver(),{operation}=await resolver.operation(page,"/api/v1.0/balance-inquiry","POST");await resolver.activateTryOut(operation,"/api/v1.0/balance-inquiry");assert.equal((await resolver.fillParameter(operation,"Content-Type","application/json")).state,"swagger-managed");await resolver.fillParameter(operation,"X-TIMESTAMP","2026-11-09T11:01:26+07:00");assert.equal(await operation.locator('input[placeholder^="X-TIMESTAMP"]').inputValue(),"2026-11-09T11:01:26+07:00");await resolver.fillBody(operation,{accountNo:"2000100101"});}finally{await browser.close();}});

test("ASPI resolver reports disabled required fields and changed forms without waiting for fill timeout",{skip:!chrome},async()=>{const browser=await chromium.launch({executablePath:chrome,headless:true});try{const page=await browser.newPage();await page.setContent(swagger());const resolver=new AspiFormResolver(),{operation}=await resolver.operation(page,"/api/v1.0/balance-inquiry","POST");await assert.rejects(resolver.fillParameter(operation,"X-SIGNATURE","secret"),error=>error.outcome==="FORM_FIELD_DISABLED");await assert.rejects(resolver.fillParameter(operation,"CHANNEL-ID","95221"),error=>error.outcome==="FORM_FIELD_NOT_FOUND");}finally{await browser.close();}});

test("ASPI resolver does not mistake an editable body for an active Try it out form",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent(`<div class="opblock opblock-post is-open"><div class="opblock-summary"><span class="opblock-summary-method">POST</span><span class="opblock-summary-path">/api/v1.0/balance-inquiry</span></div><div class="opblock-body"><button class="try-out__btn" onclick="window.tryClicks=(window.tryClicks||0)+1;if(window.tryClicks>1){this.textContent='Cancel';document.querySelector('[data-header]').disabled=false}">Try it out</button><table><tr><td class="parameters-col_name">X-TIMESTAMP * string (header)</td><td><input data-header disabled placeholder="X-TIMESTAMP - e.g 2020-01-01T00:00:00+07:00"></td></tr></table><textarea class="body-param__text">{}</textarea><button>Execute</button></div></div>`);
    const resolver=new AspiFormResolver();
    const {operation}=await resolver.operation(page,"/api/v1.0/balance-inquiry","POST");
    await resolver.activateTryOut(operation,"/api/v1.0/balance-inquiry");
    assert.equal(await page.evaluate(()=>window.tryClicks),2);
    assert.equal(await operation.locator("[data-header]").isEditable(),true);
  }finally{await browser.close();}
});

test("ASPI resolver reactivates Swagger when it resets before a header is filled",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent(swagger());
    const resolver=new AspiFormResolver();
    const {operation}=await resolver.operation(page,"/api/v1.0/balance-inquiry","POST");
    await resolver.activateTryOut(operation,"/api/v1.0/balance-inquiry");
    await operation.evaluate(element=>{
      const button=element.querySelector("button.try-out__btn");
      if(button)button.textContent="Try it out";
      const input=element.querySelector('input[placeholder^="X-TIMESTAMP"]');
      if(input)input.disabled=true;
    });
    await resolver.fillParameter(operation,"X-TIMESTAMP","2026-11-11T01:23:43+07:00");
    assert.equal(await operation.locator('input[placeholder^="X-TIMESTAMP"]').inputValue(),"2026-11-11T01:23:43+07:00");
  }finally{await browser.close();}
});

test("ASPI resolver restores Content-Type after a Swagger body rerender",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent(swagger());
    const resolver=new AspiFormResolver();
    const {operation}=await resolver.operation(page,"/api/v1.0/balance-inquiry","POST");
    await resolver.activateTryOut(operation,"/api/v1.0/balance-inquiry");
    await operation.locator('input[placeholder^="Content-Type"]').evaluate(input=>{input.disabled=false;});
    await resolver.fillParameter(operation,"Content-Type","application/json");
    await resolver.fillBody(operation,{grantType:"client_credentials"});
    await operation.locator('input[placeholder^="Content-Type"]').fill("");
    await resolver.fillParameter(operation,"Content-Type","application/json");
    assert.equal(await operation.locator('input[placeholder^="Content-Type"]').inputValue(),"application/json");
  }finally{await browser.close();}
});

test("ASPI resolver finds Swagger inside iframe",{skip:!chrome},async()=>{const browser=await chromium.launch({executablePath:chrome,headless:true});try{const page=await browser.newPage();await page.setContent(`<iframe></iframe>`);const frame=page.frames().find(item=>item!==page.mainFrame());await frame.setContent(swagger());const resolver=new AspiFormResolver(),result=await resolver.operation(page,"/api/v1.0/balance-inquiry","POST");assert.ok(result.operation);}finally{await browser.close();}});

test("ASPI session distinguishes expired login and HTTP/SNAP outcomes",{skip:!chrome},async()=>{process.env.AUTOSNAP_ENCRYPTION_KEY=Buffer.alloc(32,7).toString("base64");process.env.AUTOSNAP_PORTAL_AUTH_TIMEOUT_MS="100";const browser=await chromium.launch({executablePath:chrome,headless:true});try{const page=await browser.newPage();await page.setContent(`<a href="#">Sign In</a><p>no login form</p>`);const manager=new AspiSessionManager(),user={id:"u",data:{email:"qa@example.test",password:encrypt("password")}};await assert.rejects(manager.loginIfRequired(page,user),error=>error.outcome==="AUTH_SESSION_EXPIRED");assert.equal(classifyHttpOutcome(200,{responseCode:"2001100"}),"SUCCESS");assert.equal(classifyHttpOutcome(200,{responseCode:"4011100"}),"SNAP_BUSINESS_ERROR");assert.equal(classifyHttpOutcome(503,{}),"HTTP_ERROR");}finally{delete process.env.AUTOSNAP_PORTAL_AUTH_TIMEOUT_MS;await browser.close();}});

test("ASPI network capture distinguishes response, failed network and form that sends nothing",{skip:!chrome},async()=>{const browser=await chromium.launch({executablePath:chrome,headless:true});try{const page=await browser.newPage();await page.route("https://mock.snap.test/**",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({responseCode:"2001100",responseMessage:"Successful"})}));await page.setContent(`<button id="execute">Execute</button>`);let executions=0;const response=await captureTargetResponse(page,"POST","/api/v1.0/balance-inquiry",async()=>{executions++;await page.evaluate(()=>fetch("https://mock.snap.test/api/v1.0/balance-inquiry",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}))},2000);assert.equal(response.status(),200);await assert.rejects(captureTargetResponse(page,"POST","/api/v1.0/balance-inquiry",async()=>{executions++;},100),error=>error.outcome==="FORM_NOT_READY"&&error.diagnostic.requestDispatched===false);await page.unroute("https://mock.snap.test/**");await page.route("https://mock.snap.test/**",route=>route.abort("connectionrefused"));await assert.rejects(captureTargetResponse(page,"POST","/api/v1.0/balance-inquiry",async()=>{executions++;await page.evaluate(()=>fetch("https://mock.snap.test/api/v1.0/balance-inquiry",{method:"POST"}).catch(()=>undefined))},2000),error=>error.outcome==="TRANSPORT_ERROR"&&error.diagnostic.requestDispatched===true);assert.equal(executions,3,"capture must never retry Execute");}finally{await browser.close();}});

test("ASPI resolver uses Swagger table label when placeholder is generic", {skip:!chrome}, async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent(`<div class="opblock opblock-post is-open"><div class="opblock-summary"><span class="opblock-summary-method">POST</span><span class="opblock-summary-path">/api/v1.0/access-token/b2b</span></div><div class="opblock-body"><button class="try-out__btn" onclick="document.querySelector('input').disabled=false">Try it out</button><table><tr><td class="parameters-col_name">X-CLIENT-KEY * string (header)</td><td><input placeholder="string" disabled></td></tr></table><button>Execute</button></div></div>`);
    const resolver=new AspiFormResolver();
    const {operation}=await resolver.operation(page,"/api/v1.0/access-token/b2b","POST");
    await resolver.activateTryOut(operation,"/api/v1.0/access-token/b2b");
    assert.equal((await resolver.fillParameter(operation,"X-CLIENT-KEY","example-client")).state,"filled");
    assert.equal(await operation.locator('input').inputValue(),"example-client");
  }finally{await browser.close();}
});

test("ASPI network capture detects requests originating from iframe",{skip:!chrome},async()=>{
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const page=await browser.newPage();
    await page.route("https://mock.snap.test/**",route=>route.fulfill({status:200,contentType:"application/json",body:'{"responseCode":"2001100"}'}));
    await page.setContent("<iframe></iframe>");
    const frame=page.frames().find(frame=>frame!==page.mainFrame());
    assert.ok(frame);
    const result=await captureTargetResponse(page,"POST","/api/v1.0/access-token/b2b",async()=>{
      await frame.evaluate(()=>fetch("https://mock.snap.test/api/v1.0/access-token/b2b",{method:"POST",body:"{}"}).catch(()=>undefined));
    },2000);
    assert.equal(result.status(),200);
  }finally{await browser.close();}
});
