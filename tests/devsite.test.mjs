import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {generateKeyPairSync,randomBytes} from "node:crypto";
const require=createRequire(import.meta.url);
const {DatabaseService}=require("../backend/dist/database.service.js");
const {saveConnection}=require("../backend/dist/connection.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {RunEngine}=require("../backend/dist/run-engine.js");
const {encrypt}=require("../backend/dist/security.js");
const {request}=require("playwright-core");

test("Dev Site drafts and endpoint-first services run with the right owner and preserve history",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  process.env.AUTOSNAP_RECAPTCHA_SITE_KEY="test-site";process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY="test-secret";process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES="localhost";
  const savedFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({success:true,hostname:"localhost"})});
  const db=new DatabaseService();await db.onModuleInit();
  const engine=new RunEngine(),controller=new AutoSnapController(db,engine);
  let session="";
  const invoke=async(action,payload={})=>{
    const req={headers:{cookie:session},hostname:"localhost",body:{action,...payload}};
    const res={code:200,status(n){this.code=n;return this;},json(body){return {status:this.code,body};},cookie(k,v){session=k+"="+v;}};
    return controller.action(req,res);
  };
  try{
    await invoke("setup",{username:"admin-dev",password:"long-password-123",recaptchaToken:"test-token"});
    const user=(await invoke("save",{kind:"snap_user",name:"Mentor mengisi nanti",data:{}})).body;
    const other=(await invoke("save",{kind:"snap_user",name:"User berbeda",data:{}})).body;
    const connection=await saveConnection(db,{name:"Dev Site belum lengkap",userId:user.id,environment:{mode:"live"}});
    const client=await db.one("SELECT * FROM autosnap_records WHERE id=$1",[connection.clientId]);
    assert.equal(client.data.channelId,"95221");assert.equal(client.partner_id,null);
    const savedEndpoint=await invoke("save",{kind:"endpoint",name:"Saldo Bank Sumut",data:{method:"POST",path:"/bank/v1/balance"}});
    const endpointId=savedEndpoint.body.id;
    assert.equal((await invoke("save",{kind:"service",name:"Saldo tanpa endpoint",data:{module:"Informasi Saldo",code:"11"}})).status,400);
    const savedService=await invoke("save",{kind:"service",name:"Informasi Saldo",parentId:endpointId,data:{module:"Informasi Saldo",code:"11",requestBody:JSON.stringify({accountNo:"1234567890"})}});
    const input={clientId:connection.clientId,projectId:connection.projectId,environmentId:connection.id,userId:user.id,serviceId:savedService.body.id,endpointId,body:JSON.stringify({accountNo:"1234567890"})};
    let hitCount=0;engine.hit=async()=>{hitCount++;throw Error("Must not reach the network for an incomplete draft");};
    const blocked=await invoke("run",input);
    assert.equal(blocked.status,400);assert.match(blocked.body.error,/Base URL/);assert.equal(hitCount,0);
    await saveConnection(db,{environmentId:connection.id,userId:user.id,client:{clientId:"client-qa",clientSecret:"secret",privateKey:"fake-for-stub-only"},environment:{mode:"live",baseUrl:"https://bank.example",tokenPath:"/bank/security/token",rsaEncoding:"base64",hmacEncoding:"hex"}});
    await db.query("UPDATE autosnap_records SET data=data || '{\"authFlow\":\"provided_token\"}'::jsonb WHERE id=$1",[connection.id]);
    engine.hit=async(args)=>{assert.equal(args.authFlow,"token_b2b","legacy manual token configuration must not bypass Security");return {status:200,body:{responseCode:"2001100",responseMessage:"Successful"},request:{method:args.method,path:args.path}};};
    assert.equal((await invoke("run",input)).body.status,"Passed");
    await saveConnection(db,{environmentId:connection.id,userId:user.id,environment:{mode:"mock"}});
    const result=await invoke("run",input);assert.equal(result.status,200);assert.equal(result.body.status,"Passed");
    assert.equal((await invoke("run",{...input,userId:other.id})).status,400);
    const customBody=JSON.stringify({accountNo:"9876543210"});
    await invoke("save",{kind:"service",id:savedService.body.id,name:"Saldo baru",parentId:endpointId,data:{requestBody:customBody}});
    const service=await db.one("SELECT * FROM autosnap_records WHERE id=$1",[savedService.body.id]);
    assert.equal(service.data.requestBody,customBody);
    assert.equal((await invoke("delete",{id:user.id})).status,409,"linked User SNAP cannot be deleted");
    assert.equal((await invoke("delete",{id:connection.id})).status,200);
    assert.equal(await db.one("SELECT id FROM autosnap_records WHERE id=$1",[connection.clientId]),null,"hidden client is cleaned up");
    assert.ok(await db.one("SELECT id FROM autosnap_runs WHERE id=$1",[result.body.id]),"history survives removing the target");
    await db.upgradeDevSiteModel();
    const migrated=await db.one("SELECT * FROM autosnap_records WHERE id='seed-service-10'");
    assert.equal(migrated.parent_id,"seed-endpoint-10");
    const seedEndpoint=await db.one("SELECT * FROM autosnap_records WHERE id='seed-endpoint-10'");
    assert.equal(seedEndpoint.parent_id,null);
    assert.equal(JSON.parse(migrated.data.requestBody).accountNo,"2000100101");
  }finally{globalThis.fetch=savedFetch;await db.onModuleDestroy();}
});

test("custom token path is used and failed Security does not send Balance Inquiry",async()=>{
  process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  process.env.AUTOSNAP_ALLOWED_HOSTS="bank.example";
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
  const client={id:"client",partner_id:"client-key",data:{clientId:"client-key",clientSecret:encrypt("secret"),privateKey:encrypt(privateKey),channelId:"95221"}};
  const calls=[],saved=request.newContext;
  request.newContext=async()=>({fetch:async(url,options)=>{calls.push({url,...options});return {status:()=>401,text:async()=>JSON.stringify({responseCode:"4017300"}),headers:()=>({})};},dispose:async()=>{}});
  try{
    const result=await new RunEngine().hit({baseUrl:"https://bank.example",path:"/bank/v1/balance",method:"POST",body:{accountNo:"1234567890"},client,user:null,scenarioId:null,externalId:"123",extraHeaders:{},authFlow:"token_b2b",tokenPath:"/bank/security/token"});
    assert.equal(calls.length,1);assert.equal(calls[0].url,"https://bank.example/bank/security/token");
    assert.equal(result.status,401);assert.match(result.body.error,/Balance Inquiry tidak dikirim/);
    assert.equal(result.request.steps[0].name,"Access Token B2B");
    assert.equal(calls[0].headers["Content-Type"],"application/json");
  }finally{request.newContext=saved;}
});
