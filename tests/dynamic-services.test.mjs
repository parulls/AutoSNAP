import {createRequire as __createRequireHttp} from "node:module";
const __requireHttp=__createRequireHttp(import.meta.url);
const {RunEvidenceService}=__requireHttp("../backend/dist/run-evidence.js");
import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {readFileSync,existsSync} from "node:fs";
import {randomBytes,randomUUID} from "node:crypto";
const require=createRequire(import.meta.url);
const {parseOperation,documentationUrl,supplementSnippets}=require("../backend/dist/swagger-import.js");
const {schemaErrors,configuredChecks,validateConfig}=require("../backend/dist/endpoint-config.js");
const {resolveRequestPath}=require("../backend/dist/portal-engine.js");
const catalog=JSON.parse(readFileSync(new URL("../app/snap-spec-catalog.json",import.meta.url),"utf8"));
const origin="https://apidevportal.aspi-indonesia.or.id";
const url=origin+"/api-services/transfer-kredit/virtual-account#/VirtualAccount/updateVA";
const requestSchema={type:"object",required:["virtualAccountNo"],properties:{virtualAccountNo:{type:"string",maxLength:28}}};
const responseSchema={type:"object",required:["responseCode","responseMessage","virtualAccountData"],properties:{responseCode:{type:"string"},responseMessage:{type:"string"},virtualAccountData:{type:"object"}}};
const operation={
 operationId:"updateVA",summary:"Update VA",
 parameters:[{name:"Authorization",in:"header",required:true,schema:{type:"string"}},{name:"merchantId",in:"query",required:true,schema:{type:"string"}}],
 requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/Request"},example:{virtualAccountNo:"123"}}}},
 responses:{"200":{content:{"application/json":{schema:responseSchema,example:{responseCode:"2002800",responseMessage:"Successful",virtualAccountData:{}}}}}}
};
const spec={openapi:"3.0.0",paths:{"/api/v1.0/transfer-va/update-va":{put:operation}},components:{schemas:{Request:requestSchema}}};

test("Swagger parser selects exact operation, resolves local refs and never guesses auth or service codes",()=>{
  const draft=parseOperation(spec,url,catalog);assert.equal(draft.method,"PUT");assert.equal(draft.code,"28");assert.equal(draft.config.authFlow,"unknown");assert.equal(draft.config.reviewed,false);assert.equal(draft.config.expectedCode,"2002800");assert.deepEqual(JSON.parse(draft.requestBody),{virtualAccountNo:"123"});
  assert.deepEqual(draft.config.requestSchema.required,["virtualAccountNo"]);assert.equal(draft.config.parameters[1].required,true);
  assert.throws(()=>parseOperation(spec,url.replace("updateVA","absent"),catalog),/tidak cocok/);
  assert.throws(()=>documentationUrl("https://evil.example/api-services/a#/Group/op"),/URL operasi/);
  const unknown=structuredClone(spec);unknown.paths["/api/v1.0/custom"]=unknown.paths["/api/v1.0/transfer-va/update-va"];delete unknown.paths["/api/v1.0/transfer-va/update-va"];
  assert.equal(parseOperation(unknown,url,catalog).code,"");
});
test("required nested fields, enum and response schema are independently validated",()=>{
  const draft=parseOperation(spec,url,catalog);assert.ok(schemaErrors({},draft.config.requestSchema).length);
  assert.ok(schemaErrors({virtualAccountNo:123},draft.config.requestSchema).length);
  const incomplete=configuredChecks(200,{responseCode:"2002800",responseMessage:"ok"},draft.config);
  assert.ok(incomplete.some(check=>check.label==="Response schema"&&check.passed===null),"missing response fields stay informational under HTTP-only");
  assert.ok(incomplete.filter(check=>check.passed!==null).every(check=>check.passed),"HTTP match still passes decisive checks");
  assert.ok(configuredChecks(200,{responseCode:"2002800",responseMessage:"ok",virtualAccountData:{}},draft.config).filter(check=>check.passed!==null).every(check=>check.passed));
  assert.throws(()=>validateConfig({...draft.config,expectedCode:"made-up"}),/tujuh digit/);
  assert.equal(resolveRequestPath("/v1/items/{id}",[{name:"id",in:"path"},{name:"page",in:"query"}],{id:"a/b",page:"2"}),"/v1/items/a%2Fb?page=2");
});

test("missing explicit request sample stays blank instead of synthesizing a payload",()=>{
  const missing=structuredClone(spec),entry=missing.paths["/api/v1.0/transfer-va/update-va"].put.requestBody.content["application/json"];
  delete entry.example;missing.components.schemas.Request.properties.virtualAccountNo.default="not-a-request-sample";
  const result=parseOperation(missing,url,catalog);
  assert.equal(result.requestBody,"");assert.ok(result.config.warnings.some(warning=>warning.includes("Sample request tidak tersedia")));
  missing.paths["/api/v1.0/transfer-va/update-va"].put.description='Sample Request\n```json\n{"virtualAccountNo":"from-description","note":"a } in text"}\n```\nSample Response\n{"responseCode":"2002800"}';
  const described=parseOperation(missing,url,catalog);assert.equal(JSON.parse(described.requestBody).virtualAccountNo,"from-description");assert.equal(JSON.parse(described.requestBody).note,"a } in text");
});
test("documented requested services are represented in specification catalog, without HTTP method assumptions",()=>{
  for(const code of ["12","13","14","27","28","30","47"])assert.ok(catalog.some(row=>row.code===code));
  assert.equal(catalog.find(row=>row.code==="28").method,"PUT");
});

test("Code Snippets supplement only exact method/path; Swagger sandbox samples keep priority",()=>{
  const missing=structuredClone(spec),entry=missing.paths["/api/v1.0/transfer-va/update-va"].put;
  entry.responses={"200":{description:"Success"}};
  const snippets='Sample Request POST .../v1.0/other HTTP/1.2\n{}\nSample Response {"responseCode":"2001100"}\nSample Request PUT .../v1.0/transfer-va/update-va HTTP/1.2\n{"virtualAccountNo":"from-code-snippets"}\nSample Response\nContent-type: application/json\n{"responseCode":"2002800","responseMessage":"Successful"}';
  const draft=supplementSnippets(parseOperation(missing,url,catalog),snippets);
  assert.equal(draft.config.expectedCode,"2002800");assert.equal(JSON.parse(draft.requestBody).virtualAccountNo,"123","Swagger sample has priority over generic guide examples");
  delete entry.requestBody.content["application/json"].example;
  assert.equal(JSON.parse(supplementSnippets(parseOperation(missing,url,catalog),snippets).requestBody).virtualAccountNo,"from-code-snippets");
  assert.equal(supplementSnippets(parseOperation(missing,url,catalog),snippets.replace("2002800","2001100")).config.expectedCode,null,"other service codes are not reused");
  assert.equal(supplementSnippets(parseOperation(missing,url,catalog),snippets+snippets).config.expectedCode,null,"ambiguous duplicate samples require review");
});

test("only explicit auth and response samples are auto-filled; conditional Bearer descriptions are not guessed",()=>{
  const documented=structuredClone(spec),entry=documented.paths["/api/v1.0/transfer-va/update-va"].put;
  entry.description='Authentication: B2B2C\nSample Response\n{"responseCode":"2002800","responseMessage":"Successful"}';
  delete entry.responses["200"].content["application/json"].example;
  delete entry.responses["200"].content["application/json"].schema;
  const result=parseOperation(documented,url,catalog);assert.equal(result.config.authFlow,"b2b2c");assert.equal(result.config.expectedCode,"2002800");
  entry.description='Authentication: B2B2C\nSample Response\n{"responseCode":"4012800","responseMessage":"Unauthorized"}';
  assert.equal(parseOperation(documented,url,catalog).config.expectedCode,null,"a failure example must not become the expected success code");
  entry.description="Authorization-Customer mandatory at B2B2C use case";
  assert.equal(parseOperation(documented,url,catalog).config.authFlow,"unknown");
  entry.description="Use case: B2B\nUse case: B2B2C";
  assert.equal(parseOperation(documented,url,catalog).config.authFlow,"unknown");
  entry.description="";entry.security=[];entry.parameters=[];
  assert.equal(parseOperation(documented,url,catalog).config.authFlow,"none");
  entry.parameters=[{name:"X-SIGNATURE",in:"header",required:true,type:"string"}];
  assert.equal(parseOperation(documented,url,catalog).config.authFlow,"unknown","an explicit signature requirement is not silently treated as no authentication");
});

test("documentation cache coalesces reads, clones results and invalidates by user/credential revision",async()=>{
  const {DocumentationReader}=require("../backend/dist/documentation-reader.js"),reader=new DocumentationReader(null);
  let reads=0;reader.read=async()=>{reads++;await new Promise(resolve=>setTimeout(resolve,10));return parseOperation(spec,url,catalog);};
  const user={id:"qa",updated_at:"revision1",data:{email:"qa@example.test",password:"encrypted-revision1"}};
  const [first,concurrent]=await Promise.all([reader.inspect(user,url),reader.inspect(user,url)]);assert.equal(reads,1);
  first.config.authFlow="none";assert.equal(concurrent.config.authFlow,"unknown");
  assert.equal((await reader.inspect(user,url)).config.authFlow,"unknown");assert.equal(reads,1);
  await reader.inspect({...user,data:{...user.data,password:"encrypted-revision2"}},url);assert.equal(reads,2);
  await reader.inspect({...user,id:"other"},url);assert.equal(reads,3);
  for(const entry of reader.cache.values())entry.expires=0;
  await reader.inspect(user,url);assert.equal(reads,4);
  const failed=new DocumentationReader(null);let attempts=0;
  failed.read=async()=>{if(++attempts===1)throw Error("Fixture unavailable");return parseOperation(spec,url,catalog);};
  await assert.rejects(failed.inspect(user,url),/unavailable/);await failed.inspect(user,url);assert.equal(attempts,2,"failed reads are never cached");
});

test("headless GET signs resolved query and follows configured B2B2C customer authorization",async()=>{
  const {PortalEngine}=require("../backend/dist/portal-engine.js"),{encrypt}=require("../backend/dist/security.js");
  process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const calls=[],portal=new PortalEngine({getAuthenticatedContext:async()=>({page:{},release:async()=>{}})},null);
  portal.activitiesInContext=async()=>[];
  portal.execute=async(page,url,path,method,headers,body,parameters)=>{calls.push({path,method,headers,body,parameters});return {status:200,body:path.endsWith("signature-auth")||path.endsWith("signature-service")?{signature:"fixture"}:path.endsWith("b2b")?{accessToken:"fixture"}:{responseCode:"2003500",responseMessage:"ok"},request:{name:path}};};
  const input={portalUrl:origin+"/api-services/transfer-kredit/virtual-account#/VA/report",method:"GET",path:"/api/v1.0/transfer-va/report",body:{},authFlow:"b2b2c",parameters:{page:"2"},parameterDefinitions:[{name:"page",in:"query",required:true}],client:{partner_id:"partner",data:{clientId:"client",privateKey:encrypt("private"),clientSecret:encrypt("secret"),deviceId:"device",channelId:"95221"}},user:{data:{customerToken:encrypt("customer")}},externalId:"123",extraHeaders:{}};
  const result=await portal.hit(input);assert.equal(result.status,200);assert.equal(calls[2].headers.EndpoinUrl,"/api/v1.0/transfer-va/report?page=2");assert.equal(calls[3].method,"GET");assert.deepEqual(calls[3].body,{});assert.equal(calls[3].headers["Authorization-Customer"],"Bearer customer");await result.evidenceSession.release();
});

test("dynamic import is admin-only, atomic/idempotent and PUT runs with explicit metadata",async()=>{
  const {DatabaseService}=require("../backend/dist/database.service.js"),{AutoSnapController}=require("../backend/dist/app.js"),{createAccount}=require("../backend/dist/accounts.js"),{saveConnection}=require("../backend/dist/connection.js"),{encrypt}=require("../backend/dist/security.js");
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const id=await createAccount(db,{username:"config-admin",email:"config@example.test",password:"config-password-123"},"admin",true);let actor={id,role:"admin"};
    const now=new Date().toISOString();await db.query("INSERT INTO autosnap_records(id,kind,name,data,created_at,updated_at) VALUES('dynamic-user','snap_user','QA',$1::jsonb,$2,$2)",[JSON.stringify({email:"qa@example.test",password:encrypt("fixture")}),now]);
    let calls=0;
    const portal={hit:async input=>{calls++;assert.equal(input.method,"PUT");assert.equal(input.authFlow,"b2b");assert.equal(input.parameters.merchantId,"merchant");return {status:200,body:{responseCode:"2002800",responseMessage:"Successful",virtualAccountData:{}},request:{method:input.method,path:input.path,body:input.body,steps:[{name:"/api/v1.0/utilities/signature-auth",method:"POST",httpStatus:200},{name:"/api/v1.0/access-token/b2b",method:"POST",httpStatus:200},{name:"/api/v1.0/utilities/signature-service",method:"POST",httpStatus:200},{name:input.path,method:input.method,httpStatus:200}]}};},collectEvidence:async input=>input.paths.map((path,index)=>({key:input.operations?.[index]?.key,path,activity:{activityId:randomUUID(),service:path,timestamp:now,downloadUrl:"https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity"},pdf:Buffer.from(`%PDF-1.7\n${path}\n%%EOF\n`)}))};
    const evidence=new RunEvidenceService(db,portal);
    const controller=new AutoSnapController(db, null, portal, {inspect:async()=>parseOperation(spec,url,catalog)}, evidence);controller.user=async()=>actor;controller.enforceRateLimit=async()=>{};
    const action=async(action,input={})=>{const res={code:200,status(n){this.code=n;return this;},json(body){return {status:this.code,body};}};return controller.action({body:{action,...input},headers:{}},res);};
    actor={id,role:"petugas"};assert.equal((await action("inspectDocumentation",{url,userId:"dynamic-user"})).status,403);actor={id,role:"admin"};
    const draft=(await action("inspectDocumentation",{url,userId:"dynamic-user"})).body;assert.equal(calls,0);
    draft.config.authFlow="b2b";draft.config.reviewed=true;
    const saved=await action("saveImportedService",{draft});assert.equal(saved.status,200);const again=await action("saveImportedService",{draft});assert.equal(saved.body.serviceId,again.body.serviceId);
    const site=await saveConnection(db,{name:"Dynamic QA",userId:"dynamic-user",client:{clientId:"dynamic-client",clientSecret:"secret",privateKey:"private"},environment:{mode:"portal"}});
    const input={progressId:randomUUID(),clientId:site.clientId,projectId:site.projectId,environmentId:site.id,userId:"dynamic-user",serviceId:saved.body.serviceId,endpointId:saved.body.endpointId,body:JSON.stringify({virtualAccountNo:"123"}),parameters:{merchantId:"merchant"}};
    const run=await action("run",input);assert.equal(run.status,200);assert.equal(run.body.status,"PASSED");assert.equal(calls,1);
    assert.equal((await action("run",input)).status,409);assert.equal(calls,1,"same progress ID cannot execute twice");
    assert.equal((await action("run",{...input,body:"{}"})).status,400);assert.equal(calls,1,"invalid body never executes");
    assert.equal((await action("run",{...input,parameters:{Authorization:"injected"}})).status,400);assert.equal(calls,1);
    const history=await db.one("SELECT request_json FROM autosnap_runs WHERE id=$1",[run.body.id]);assert.equal(history.request_json.endpointConfiguration.authFlow,"b2b");
    draft.requestBody="";draft.endpointId=saved.body.endpointId;draft.serviceId=saved.body.serviceId;
    draft.name="Update VA reviewed";draft.portalUrl=url.replace("updateVA","reviewedVA");draft.config.sourceUrl=draft.portalUrl;draft.config.operationId="reviewedVA";
    const edited=await action("saveImportedService",{draft});assert.equal(edited.status,200);assert.equal(edited.body.endpointId,saved.body.endpointId);assert.equal(edited.body.serviceId,saved.body.serviceId);
    assert.equal((await db.one("SELECT data FROM autosnap_records WHERE id=$1",[saved.body.serviceId])).data.requestBody,"");
    const empty=await action("run",{...input,progressId:randomUUID(),body:""});assert.equal(empty.status,400);assert.equal(calls,1);
    actor={id,role:"petugas"};assert.equal((await action("deleteEndpointConfiguration",{id:saved.body.endpointId})).status,403);actor={id,role:"admin"};
    assert.equal((await action("deleteEndpointConfiguration",{id:saved.body.endpointId})).status,200);
    assert.equal(await db.one("SELECT id FROM autosnap_records WHERE id=$1",[saved.body.serviceId]),null);
    assert.ok(await db.one("SELECT id FROM autosnap_runs WHERE id=$1",[run.body.id]),"history survives explicit configuration deletion");
  }finally{await db.onModuleDestroy();}
});

const chrome=["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
test("headless documentation reader extracts Swagger while blocking documentation-page POST requests",{skip:!chrome},async()=>{
  const {chromium}=require("playwright-core"),{DocumentationReader}=require("../backend/dist/documentation-reader.js");
  const browser=await chromium.launch({executablePath:chrome,headless:true});let mutations=0,navigations=0;
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await context.route(origin+"/**",route=>{if(route.request().isNavigationRequest())navigations++;if(route.request().method()!=="GET"||route.request().url().includes("/api/v1"))mutations++;return route.fulfill({contentType:"text/html",body:`<script>window.ui={getSystem:()=>({specSelectors:{specJson:()=>({toJS:()=>(${JSON.stringify(spec)})})}})};fetch('/blocked-api',{method:'POST'}).catch(()=>{});fetch('/api/v1.0/blocked-get').catch(()=>{});</script>`});});
    const reader=new DocumentationReader({getAuthenticatedContext:async(user,host,validate)=>{await validate(page);return {context,page,release:async()=>context.close()};}});
    const start=Date.now(),result=await reader.inspect({id:"qa",data:{}},url);assert.equal(result.method,"PUT");assert.equal(mutations,0);
    assert.equal(navigations,1,"no duplicate documentation navigation");assert.ok(Date.now()-start<6000,"does not wait for an opblock when Swagger metadata is ready");
    await reader.inspect({id:"qa",data:{}},url);assert.equal(navigations,1,"cached read does not reopen the browser");
  }finally{await browser.close();}
});

test("public documentation without Swagger triggers legitimate session login instead of a false successful validation",{skip:!chrome},async()=>{
  const {chromium}=require("playwright-core"),{DocumentationReader}=require("../backend/dist/documentation-reader.js");
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage();let authorized=false,checks=0;
    await context.route(origin+"/**",route=>route.fulfill({contentType:"text/html",body:authorized?`<script>window.ui={specSelectors:{specJson:()=>({toJS:()=>(${JSON.stringify(spec)})})}};</script>`:'<a href="/sign-in">Sign In</a><button data-target="#sandBoxCollapse">Aplikasi Pengujian</button>'}));
    const reader=new DocumentationReader({getAuthenticatedContext:async(user,host,validate)=>{
      assert.equal(await validate(page),false,"public overview is not an authenticated Swagger session");checks++;
      authorized=true;await page.goto(origin+"/sign-in");assert.equal(await validate(page),true);checks++;
      return {context,page,release:async()=>context.close()};
    }});
    const result=await reader.inspect({id:"login-fixture",data:{}},url);assert.equal(result.method,"PUT");assert.equal(checks,2);
  }finally{await browser.close();}
});

test("ASPI Swagger JSON on a separate HTTPS port is readable, but transaction GET remains blocked",{skip:!chrome},async()=>{
  const {chromium}=require("playwright-core"),{DocumentationReader}=require("../backend/dist/documentation-reader.js");
  const browser=await chromium.launch({executablePath:chrome,headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage();let schemas=0,transactions=0;
    await context.route("https://apidevportal.aspi-indonesia.or.id*/**",route=>{
      const target=new URL(route.request().url());
      if(target.port==="44310"){
        if(target.pathname.startsWith("/api/"))transactions++;else schemas++;
        return route.fulfill({headers:{"access-control-allow-origin":origin},contentType:"application/json",body:JSON.stringify(spec)});
      }
      return route.fulfill({contentType:"text/html",body:`<script>fetch('${origin}:44310/swagger/virtualaccount.json').catch(()=>{});fetch('${origin}:44310/api/v1.0/blocked-inquiry').catch(()=>{});</script>`});
    });
    const reader=new DocumentationReader({getAuthenticatedContext:async(user,host,validate)=>{assert.equal(await validate(page),true);return {context,page,release:async()=>context.close()};}});
    const result=await reader.inspect({id:"schema-port-fixture",data:{}},url);assert.equal(result.method,"PUT");assert.equal(schemas,1);assert.equal(transactions,0);
  }finally{await browser.close();}
});
