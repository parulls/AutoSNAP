import {createRequire as __createRequireHttp} from "node:module";
const __requireHttp=__createRequireHttp(import.meta.url);
const {RunEvidenceService}=__requireHttp("../backend/dist/run-evidence.js");
import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {existsSync,readFileSync} from "node:fs";
import {createHash,createHmac,generateKeyPairSync,randomBytes,randomUUID,sign,verify} from "node:crypto";

const require=createRequire(import.meta.url);
const {chromium}=require("playwright-core");
const {AspiFormResolver}=require("../backend/dist/aspi-form-resolver.js");
const {PortalEngine}=require("../backend/dist/portal-engine.js");
const {DatabaseService}=require("../backend/dist/database.service.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {createAccount}=require("../backend/dist/accounts.js");
const {saveConnection}=require("../backend/dist/connection.js");
const {encrypt}=require("../backend/dist/security.js");
const {parseOperation}=require("../backend/dist/swagger-import.js");
const {authenticationWorkflow}=require("../backend/dist/auth-workflow.js");
const {resolveEndpoint,scenarioExpectation}=require("../backend/dist/endpoint-resolver.js");
const {resolveRequestPath}=require("../backend/dist/request-builder.js");
const {prepareBody}=require("../backend/dist/request-builder.js");
const catalog=JSON.parse(readFileSync(new URL("../app/snap-spec-catalog.json",import.meta.url),"utf8"));
const chrome=["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
const origin="https://apidevportal.aspi-indonesia.or.id";
const security=["/api/v1.0/utilities/signature-auth","/api/v1.0/access-token/b2b","/api/v1.0/utilities/signature-service"];
const fixtures=[
  {name:"Balance Inquiry",method:"POST",path:"/api/v1.0/balance-inquiry",section:"informasi-saldo",group:"BalanceInquiry",code:"11",expected:"2001100",negative:"4011101",body:{partnerReferenceNo:"2020102900000000000001",bankCardToken:"6d7963617264746f6b656e",accountNo:"2000100101",balanceTypes:["Cash","Coins"],additionalInfo:{deviceId:"12345679237",channel:"mobilephone"}},required:["accountNo"],responseField:"accountInfos",responseValue:[]},
  {name:"Bank Statement",method:"POST",path:"/api/v1.0/bank-statement",section:"riwayat-transaksi",group:"TransactionHistory",code:"14",expected:"2001400",negative:"4011401",body:{partnerReferenceNo:"2020102900000000000001",accountNo:"2000200202",fromDateTime:"2020-01-01T00:00:00+07:00",toDateTime:"2020-01-02T00:00:00+07:00"},required:["accountNo","fromDateTime","toDateTime"],responseField:"detailData",responseValue:[]},
  {name:"Transaction History List",method:"POST",path:"/api/v1.0/transaction-history-list",section:"riwayat-transaksi",group:"TransactionHistory",code:"12",expected:"2001200",negative:"4011201",body:{partnerReferenceNo:"2020102900000000000001",fromDateTime:"2020-01-01T00:00:00+07:00",toDateTime:"2020-01-02T00:00:00+07:00",pageSize:"10",pageNumber:"1"},required:["fromDateTime","toDateTime"],responseField:"detailData",responseValue:[]},
  {name:"Transaction History Detail",method:"POST",path:"/api/v1.0/transaction-history-detail",section:"riwayat-transaksi",group:"TransactionHistory",code:"13",expected:"2001300",negative:"4011301",body:{originalPartnerReferenceNo:"2020102900000000000001"},required:["originalPartnerReferenceNo"],responseField:"detailData",responseValue:[]},
  {name:"Create Virtual Account",method:"POST",path:"/api/v1.0/transfer-va/create-va",section:"transfer-kredit/virtual-account",group:"VirtualAccount",code:"27",expected:"2002700",negative:"4012701",body:{partnerServiceId:"   12345",customerNo:"123456",virtualAccountNo:"   12345123456",virtualAccountName:"FIXTURE ACCOUNT",trxId:"fixture-create",totalAmount:{value:"10000.00",currency:"IDR"}},required:["partnerServiceId","customerNo","virtualAccountNo","trxId"],responseField:"virtualAccountData",responseValue:{}},
  {name:"Update Virtual Account",method:"PUT",path:"/api/v1.0/transfer-va/update-va",section:"transfer-kredit/virtual-account",group:"VirtualAccount",code:"28",expected:"2002800",negative:"4012801",body:{partnerServiceId:"   12345",customerNo:"123456",virtualAccountNo:"   12345123456",virtualAccountName:"UPDATED FIXTURE",trxId:"fixture-update"},required:["partnerServiceId","customerNo","virtualAccountNo","trxId"],responseField:"virtualAccountData",responseValue:{}}
];
const headerNames=["Content-Type","Authorization","X-TIMESTAMP","X-SIGNATURE","X-PARTNER-ID","X-EXTERNAL-ID","CHANNEL-ID"];
const idFor=f=>f.method.toLowerCase()+f.path.replace(/\W/g,"_");
const draftFor=f=>{
  const responseSchema={type:"object",required:["responseCode","responseMessage",f.responseField],properties:{responseCode:{type:"string"},responseMessage:{type:"string"},[f.responseField]:{type:Array.isArray(f.responseValue)?"array":"object"}}};
  const operation={operationId:idFor(f),summary:f.name,description:"Authentication: B2B",parameters:headerNames.map(name=>({name,in:"header",required:true,type:"string"})).concat([{name:"body",in:"body",required:true,schema:{type:"object",required:f.required,properties:Object.fromEntries(f.required.map(name=>[name,{type:"string"}]))},example:f.body}]),responses:{200:{schema:responseSchema,examples:{"application/json":{responseCode:f.expected,responseMessage:"Successful",[f.responseField]:f.responseValue}}},401:{description:"Invalid access token",examples:{"application/json":{responseCode:f.negative,responseMessage:"Access Token Invalid"}}}}};
  return parseOperation({swagger:"2.0",paths:{[f.path]:{[f.method.toLowerCase()]:operation}}},`${origin}/api-services/${f.section}#/${f.group}/${idFor(f)}`,catalog);
};

test("endpoint resolver binds IDs, method, path, URL, expectation and workflow without name-based routing",()=>{
  const draft=draftFor(fixtures[1]);draft.config.reviewed=true;
  const e={id:"statement",kind:"endpoint",data:{method:draft.method,path:draft.path,portalUrl:draft.portalUrl}};
  const s={id:"statement-service",kind:"service",parent_id:e.id,data:{code:draft.code,config:draft.config}};
  assert.equal(resolveEndpoint(e,s).path,"/api/v1.0/bank-statement");
  assert.throws(()=>resolveEndpoint({...e,data:{...e.data,path:"/api/v1.0/balance-inquiry"}},s),/Method\/path/);
  assert.throws(()=>resolveEndpoint(e,{...s,parent_id:"balance"}),/melekat/);
  assert.throws(()=>resolveEndpoint(e,{...s,data:{code:"11"}}),/tidak ada fallback/);
  assert.equal(resolveEndpoint(e,{...s,data:{...s.data,config:{...draft.config,expectedCode:"2001100"}}}).path,"/api/v1.0/bank-statement","a well-formed incorrect expectation must be evaluated, not used to route or block the request");
  assert.deepEqual(scenarioExpectation(draft.config,false,true),{expectedHttpStatus:401,expectedCode:null},"negative testing ignores SNAP expected codes");
  const noNegative={...draft.config};delete noNegative.negativeToken;
  assert.deepEqual(scenarioExpectation(noNegative,false,true),{expectedHttpStatus:401,expectedCode:null},"missing expected code must not block a negative request");
  assert.throws(()=>resolveRequestPath("/api/{id}",[{name:"id",in:"path"}],{}),/wajib/);
  assert.throws(()=>resolveRequestPath("/api/{id}",[{name:"id",in:"path"}],{id:".."}),/dot segment/);
  assert.equal(resolveRequestPath("/api/{id}",[{name:"id",in:"path"},{name:"page",in:"query"}],{id:"a/b",page:2}),"/api/a%2Fb?page=2");
  assert.deepEqual(prepareBody("","POST",{requestBodyMode:"none"},"",()=>""),{});
  assert.throws(()=>prepareBody('{"borrowedBody":true}',"POST",{requestBodyMode:"none"},"",()=>""),/tidak memakai JSON body/);
});

test("workflow plans only required security dependencies and refuses contradictory metadata",()=>{
  const plan=authenticationWorkflow({authFlow:"none",parameters:[]});assert.deepEqual(plan.nodes.map(n=>n.stage),["api_request"]);
  const provided=authenticationWorkflow({authFlow:"b2b",workflow:{token:"provided",signature:"none",customerToken:"none"},parameters:[]});assert.deepEqual(provided.nodes.map(n=>n.stage),["access_token","api_request"]);
  const customer=authenticationWorkflow({authFlow:"b2b2c",parameters:[]});assert.deepEqual(customer.nodes.map(n=>n.stage),["signature_auth","access_token","customer_token","signature_service","api_request"]);
  assert.throws(()=>authenticationWorkflow({authFlow:"none",parameters:[{name:"X-SIGNATURE",in:"header",required:true}]}),/header keamanan wajib/);
});

/** A local portal fixture, not the real ASPI service. ALL network requests are intercepted. */
function operationHtml(path,method,headers,hasBody,parameters=[]){
  return `<div class="opblock is-open"><div class="opblock-summary"><span class="opblock-summary-method">${method}</span><span class="opblock-summary-path">${path}</span></div><div class="opblock-body"><button class="try-out__btn" onclick="this.textContent='Cancel';this.closest('.opblock').querySelectorAll('[disabled]').forEach(e=>e.disabled=false)">Try it out</button><table>${[...headers.map(name=>({name,location:"header"})),...parameters].map(p=>`<tr><td class="parameters-col_name">${p.name} * string (${p.location})</td><td><input disabled data-location="${p.location}" name="${p.name}" placeholder="${p.name}"></td></tr>`).join("")}</table>${hasBody?'<textarea disabled class="body-param__text">{}</textarea>':""}<button onclick="runOperation(this)">Execute</button></div></div>`;
}
const pageScript=`<script>async function runOperation(button){const op=button.closest('.opblock'),headers={},query=new URLSearchParams();let path=op.querySelector('.opblock-summary-path').textContent,method=op.querySelector('.opblock-summary-method').textContent;for(const field of op.querySelectorAll('input')){if(field.dataset.location==='query')query.append(field.name,field.value);else if(field.dataset.location==='path')path=path.replace('{'+field.name+'}',encodeURIComponent(field.value));else if(field.value)headers[field.name]=field.value;}const text=op.querySelector('textarea')?.value??'',body=['GET','HEAD'].includes(method)?undefined:text.trim()?JSON.stringify(JSON.parse(text)):undefined;await fetch(path+(query.size?'?'+query:''),{method,headers,body});}</script>`;

test("six services execute the real headless form pipeline, signatures, positive/negative validation, history and PDF mapping",{skip:!chrome,timeout:180000},async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const browser=await chromium.launch({executablePath:chrome,headless:true}),context=await browser.newContext();
  const db=new DatabaseService();await db.onModuleInit();
  const key=generateKeyPairSync("rsa",{modulusLength:2048}),privateKey=key.privateKey.export({format:"der",type:"pkcs8"}).toString("base64"),secret="fixture-client-secret";
  const observed=[],signatureInputs=[];let missingResponseField=false;
  const html=operationHtml(security[0],"POST",["X-TIMESTAMP","X-CLIENT-KEY","Private_Key"],false)+operationHtml(security[1],"POST",["Content-Type","X-TIMESTAMP","X-CLIENT-KEY","X-SIGNATURE"],true)+operationHtml(security[2],"POST",["Content-Type","X-TIMESTAMP","X-CLIENT-SECRET","HttpMethod","EndpoinUrl","AccessToken"],true)+fixtures.map(f=>operationHtml(f.path,f.method,headerNames,true)).join("")+pageScript;
  await context.route("**/*",async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==origin)return route.abort("blockedbyclient");
    if(req.isNavigationRequest())return route.fulfill({contentType:"text/html",body:html});
    const path=url.pathname,headers=await req.allHeaders(),raw=req.postData()??"",body=raw?JSON.parse(raw):{};
    observed.push({path,method:req.method(),headers,body});
    const respond=(status,body)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path===security[0])return respond(200,{signature:sign("RSA-SHA256",Buffer.from(`${headers["x-client-key"]}|${headers["x-timestamp"]}`),{key:Buffer.from(headers.private_key,"base64"),format:"der",type:"pkcs8"}).toString("base64")});
    if(path===security[1]){
      assert.ok(verify("RSA-SHA256",Buffer.from(`${headers["x-client-key"]}|${headers["x-timestamp"]}`),key.publicKey,Buffer.from(headers["x-signature"],"base64")));
      assert.equal(body.grantType,"client_credentials");return respond(200,{accessToken:`fixture-token-${headers["x-client-key"]}`});
    }
    if(path===security[2]){
      const canonical=`${headers.httpmethod}:${headers.endpoinurl}:${headers.accesstoken}:${createHash("sha256").update(raw?JSON.stringify(body):"").digest("hex")}:${headers["x-timestamp"]}`;
      signatureInputs.push({canonical,method:headers.httpmethod,path:headers.endpoinurl,body});
      return respond(200,{signature:createHmac("sha512",headers["x-client-secret"]).update(canonical).digest("hex")});
    }
    const f=fixtures.find(item=>item.path===path);assert.ok(f,"no other service may execute");assert.equal(req.method(),f.method);assert.deepEqual(body,f.body);
    const token=headers.authorization.slice(7),canonical=`${req.method()}:${url.pathname+url.search}:${token}:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}:${headers["x-timestamp"]}`;
    assert.equal(headers["x-signature"],createHmac("sha512",secret).update(canonical).digest("hex"),"signature must match actual target method/path/body/token/timestamp");
    if(token.endsWith("INVALID"))return respond(401,{responseCode:f.negative,responseMessage:"Access Token Invalid"});
    return respond(200,{responseCode:f.expected,responseMessage:"Successful",...(!missingResponseField?{[f.responseField]:f.responseValue}:{})});
  });
  try{
    const owner=await createAccount(db,{username:"dynamic-owner",email:"dynamic@example.test",password:"dynamic-password-123"},"admin",true);
    const now=new Date().toISOString();await db.query("INSERT INTO autosnap_records(id,kind,name,data,created_at,updated_at) VALUES('execution-user','snap_user','QA',$1::jsonb,$2,$2)",[JSON.stringify({email:"qa@example.test",password:encrypt("fixture")}),now]);
    const connection=await saveConnection(db,{name:"Dynamic Portal Fixture",userId:"execution-user",client:{clientId:"execution-client",clientSecret:secret,privateKey},environment:{mode:"portal"}});
    const portal=new PortalEngine({getAuthenticatedContext:async(user,host,validate)=>{assert.equal(user.id,"execution-user");const page=await context.newPage();assert.equal(await validate(page),true);return {page,release:async()=>page.close()};}},new AspiFormResolver());
    portal.activitiesInContext=async()=>[];
    let evidencePaths=[];
    portal.collectEvidence=async input=>{evidencePaths=input.paths;return input.paths.map((path,index)=>({key:input.operations?.[index]?.key,path,activity:{activityId:randomUUID(),service:path,timestamp:now,downloadUrl:"https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity"},pdf:Buffer.from(`%PDF-1.7\nFixture ${index}`)}));};
    const controller=new AutoSnapController(db, null, portal, null, new RunEvidenceService(db, portal));controller.user=async()=>({id:owner,role:"admin"});controller.enforceRateLimit=async()=>{};
    const action=async(action,input={})=>{const res={code:200,status(code){this.code=code;return this;},json(body){return {status:this.code,body};}};return controller.action({body:{action,...input},headers:{}},res);};
    for(const f of fixtures){
      const draft=draftFor(f);draft.config.reviewed=true;
      const saved=await action("saveImportedService",{draft});assert.equal(saved.status,200,JSON.stringify(saved.body));
      const input={progressId:randomUUID(),clientId:connection.clientId,projectId:connection.projectId,environmentId:connection.id,userId:"execution-user",serviceId:saved.body.serviceId,endpointId:saved.body.endpointId,body:JSON.stringify(f.body)};
      for(const testType of ["positive","invalid_access_token"]){
        const before=observed.length;
        const result=await action("run",{...input,progressId:randomUUID(),testType});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.status,"PASSED",`${f.name} ${testType}: ${JSON.stringify(result.body.checks)}`);
        assert.equal(result.body.httpStatus,testType==="positive"?200:401);assert.equal(result.body.responseCode,testType==="positive"?f.expected:f.negative);
        assert.deepEqual(observed.slice(before).map(req=>req.path),[...security,f.path],`${f.name}: no unrelated service or duplicate request`);
        assert.deepEqual(evidencePaths,[...security,f.path]);
        const history=await db.one("SELECT * FROM autosnap_runs WHERE id=$1",[result.body.id]);assert.equal(history.endpoint_id,saved.body.endpointId);assert.equal(history.service_id,saved.body.serviceId);assert.equal(history.request_json.path,f.path);assert.equal(history.request_json.method,f.method);assert.equal(history.request_json.context.service,f.name);
        assert.equal(history.request_json.configurationIds.endpointId,saved.body.endpointId);
        assert.ok(history.request_json.progressLog.some(step=>step.stage==="api_request"&&step.detail.includes(f.name)&&step.detail.includes(f.path)));
        assert.ok(!history.request_json.progressLog.some(step=>step.stage==="balance_inquiry"));
        assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM autosnap_evidence_pdfs WHERE run_id=$1 AND activity_id<>'autosnap-report-v1'",[history.id])).n,4);
        assert.ok(!JSON.stringify(history).includes(secret));assert.ok(!JSON.stringify(history).includes("fixture-token-execution-client"));
      }
      if(f.name==="Bank Statement"){
        missingResponseField=true;const informational=await action("run",{...input,progressId:randomUUID()});missingResponseField=false;
        assert.equal(informational.body.status,"PASSED","response schema remains informational");assert.ok(informational.body.checks.some(c=>c.label==="Response schema"&&c.passed===null));
        assert.equal(informational.body.evaluation.mode,"SNAP_AND_HTTP");
        const old=observed.length;const invalid=await action("run",{...input,progressId:randomUUID(),body:JSON.stringify({accountNo:"2000100101",balanceTypes:["Cash"]})});assert.equal(invalid.status,400);assert.equal(observed.length,old,"Balance payload is refused before any browser/API request");
        const retry={...input,progressId:randomUUID()};assert.equal((await action("run",retry)).body.status,"PASSED");const sent=observed.length;assert.equal((await action("run",retry)).status,409);assert.equal(observed.length,sent,"no automatic transaction retry");
        const optionalDraft=structuredClone(draft);optionalDraft.config.expectedCode=null;optionalDraft.config.negativeToken.expectedCode=null;
        assert.equal((await action("saveImportedService",{draft:optionalDraft})).status,200);
        for(const testType of ["positive","invalid_access_token"]){
          const before=observed.length,notEvaluated=await action("run",{...input,progressId:randomUUID(),testType});
          assert.equal(notEvaluated.body.status,"PASSED");assert.equal(notEvaluated.body.outcome,"PASSED");assert.equal(notEvaluated.body.expectedCode,null);assert.equal(notEvaluated.body.httpStatus,testType==="positive"?200:401);assert.equal(notEvaluated.body.responseCode,testType==="positive"?f.expected:f.negative);
          assert.equal(notEvaluated.body.evaluation.mode,"HTTP_ONLY");
          assert.deepEqual(observed.slice(before).map(req=>req.path),[...security,f.path],"missing expected does not bypass the actual security or API procedure");
          const row=await db.one("SELECT * FROM autosnap_runs WHERE id=$1",[notEvaluated.body.id]);assert.equal(row.expected_code,null);assert.equal(row.request_json.evaluation.outcome,"PASSED");assert.equal(row.request_json.evaluation.mode,"HTTP_ONLY");assert.ok(row.request_json.progressLog.some(step=>step.stage==="finished"&&step.status==="completed"));
        }
      }
    }
    assert.equal(signatureInputs.filter(item=>item.method==="PUT").length,2,"Update VA signs PUT for positive and negative");
  }finally{await context.close();await browser.close();await db.onModuleDestroy();}
});

test("headless GET signs the resolved path/query and empty body; none/provided workflows skip unnecessary dependencies",{skip:!chrome,timeout:45000},async()=>{
  process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const browser=await chromium.launch({executablePath:chrome,headless:true}),context=await browser.newContext(),calls=[];
  const path="/api/v1.0/transfer-va/report/{reportId}",parameters={reportId:"fixture/one",page:"2",search:"a b"};
  const definitions=[{name:"reportId",in:"path",required:true},{name:"page",in:"query",required:true},{name:"search",in:"query",required:true}];
  const resolved=resolveRequestPath(path,definitions,parameters),secret="fixture-get-secret";
  const html=operationHtml(security[2],"POST",["Content-Type","X-TIMESTAMP","X-CLIENT-SECRET","HttpMethod","EndpoinUrl","AccessToken"],true)+operationHtml(path,"GET",headerNames,false,definitions.map(p=>({name:p.name,location:p.in})))+pageScript;
  let authFlow="b2b";
  await context.route("**/*",async route=>{
    const req=route.request(),url=new URL(req.url());assert.equal(url.origin,origin);
    if(req.isNavigationRequest())return route.fulfill({contentType:"text/html",body:html});
    const headers=await req.allHeaders(),raw=req.postData()??"";calls.push({url,method:req.method(),headers,raw});
    const send=body=>route.fulfill({contentType:"application/json",body:JSON.stringify(body)});
    if(url.pathname===security[2]){
      assert.equal(headers.httpmethod,"GET");assert.equal(headers.endpoinurl,resolved);assert.equal(raw,"","Signature utility hashes empty string for a body-less target, not '{}'");
      const canonical=`GET:${resolved}:${headers.accesstoken}:${createHash("sha256").update("").digest("hex")}:${headers["x-timestamp"]}`;
      return send({signature:createHmac("sha512",secret).update(canonical).digest("hex")});
    }
    assert.equal(url.pathname+url.search,resolved);assert.equal(req.method(),"GET");assert.equal(raw,"");
    if(authFlow==="b2b"){
      assert.equal(headers.authorization,"Bearer cached-valid-token");
      const canonical=`GET:${resolved}:cached-valid-token:${createHash("sha256").update("").digest("hex")}:${headers["x-timestamp"]}`;
      assert.equal(headers["x-signature"],createHmac("sha512",secret).update(canonical).digest("hex"));
    }else assert.equal(headers.authorization,undefined);
    return send({responseMessage:"Fixture report"});
  });
  const user={id:"get-user",data:{}},client={id:"get-client",partner_id:"get-partner",data:{clientId:"get-client",channelId:"95221",clientSecret:encrypt(secret),accessToken:encrypt("cached-valid-token"),accessTokenExpiresAt:new Date(Date.now()+60000).toISOString()}};
  const engine=new PortalEngine({getAuthenticatedContext:async(u,h,validate)=>{const page=await context.newPage();assert.equal(await validate(page),true);return {page,release:async()=>page.close()};}},new AspiFormResolver());engine.activitiesInContext=async()=>[];
  try{
    let progress=[];
    const base={user,client,path,method:"GET",body:{},portalUrl:origin+"/api-services/transfer-kredit/virtual-account#/VirtualAccount/fixtureReport",parameters,parameterDefinitions:definitions,externalId:"12345",extraHeaders:{},onProgress:async(stage,status)=>progress.push({stage,status})};
    let result=await engine.hit({...base,authFlow,workflow:{token:"provided",signature:"hmac",customerToken:"none"}});
    assert.equal(result.status,200);assert.ok(result.request.automationChecks.every(c=>c.passed));assert.equal(result.request.body,null);assert.deepEqual(calls.map(c=>c.url.pathname),[security[2],resolved.split("?")[0]]);await result.evidenceSession.release();
    assert.ok(!progress.some(p=>p.stage==="signature_auth"));
    calls.length=0;progress=[];authFlow="none";
    result=await engine.hit({...base,authFlow});assert.equal(result.status,200);assert.equal(calls.length,1);assert.ok(progress.every(p=>p.stage==="api_request"));await result.evidenceSession.release();
    calls.length=0;
    result=await engine.hit({...base,authFlow:"b2b",workflow:{token:"provided",signature:"hmac",customerToken:"none"},client:{...client,data:{...client.data,accessTokenExpiresAt:"2000-01-01T00:00:00Z"}}});
    assert.equal(result.outcome,"PRECONDITION_FAILED");assert.equal(result.status,null);assert.equal(calls.length,0,"expired token never reaches an API or refreshes silently");
  }finally{await context.close();await browser.close();}
});
