import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require=createRequire(import.meta.url);
const {DatabaseService}=require("../backend/dist/database.service.js");
const {saveConnection}=require("../backend/dist/connection.js");
const {decrypt}=require("../backend/dist/security.js");
const {createElement}=require("react");
const {renderToStaticMarkup}=require("react-dom/server");
const ts=require("typescript");
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");

// Render actual components without a browser or an authenticated production database.
function component(relative){
  const cache=new Map();
  const load=file=>{
    if(cache.has(file))return cache.get(file).exports;
    const loadedModule={exports:{}};cache.set(file,loadedModule);
    const compiled=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    const localRequire=id=>{if(!id.startsWith("."))return require(id);const path=resolve(dirname(file),id);const target=[path+".tsx",path+".ts",path+".json"].find(existsSync);if(!target)throw Error("Missing import "+id);return target.endsWith(".json")?JSON.parse(readFileSync(target,"utf8")):load(target);};
    new Function("require","module","exports",compiled)(localRequire,loadedModule,loadedModule.exports);
    return loadedModule.exports;
  };
  return load(resolve(root,relative)).default;
}

test("one connection form prepares the full hierarchy, preserves secrets on edit, and rolls back on failure",async()=>{
  delete process.env.DATABASE_URL;
  process.env.AUTOSNAP_PGLITE_DIR="memory://";
  process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const snapUserId="snap-owner";
    await db.query("INSERT INTO autosnap_records (id,kind,name,parent_id,partner_id,data,created_at,updated_at) VALUES ($1,'snap_user','Owner',NULL,NULL,$2::jsonb,$3,$3)",[snapUserId,JSON.stringify({email:"owner@example.test",username:"owner@example.test"}),new Date().toISOString()]);
    const created=await saveConnection(db,{name:"Simulasi",userId:snapUserId,environment:{mode:"mock"}});
    const [client]=await db.query("SELECT * FROM autosnap_records WHERE id=$1",[created.clientId]);
    const [project]=await db.query("SELECT * FROM autosnap_records WHERE id=$1",[created.projectId]);
    const [environment]=await db.query("SELECT * FROM autosnap_records WHERE id=$1",[created.id]);
    assert.equal(project.parent_id,client.id);assert.equal(environment.parent_id,project.id);
    assert.equal(client.partner_id,null,"drafts do not fabricate Client IDs or Partner IDs");
    assert.equal(client.data.channelId,"95221");
    assert.equal(environment.data.authFlow,"token_b2b");
    const updated=await saveConnection(db,{name:"Sandbox",environmentId:created.id,client:{clientId:"client-qa",clientSecret:"a-secret",privateKey:"a-key",publicKey:"registered-public",channelId:"95221"},environment:{mode:"live",baseUrl:"https://sandbox.example",useCase:"B2B"}});
    assert.equal(updated.id,created.id);assert.equal(updated.clientId,created.clientId);
    await saveConnection(db,{name:"Sandbox Renamed",environmentId:created.id,client:{clientSecret:"",privateKey:""},environment:{mode:"live"}});
    const [after]=await db.query("SELECT * FROM autosnap_records WHERE id=$1",[created.clientId]);
    assert.equal(decrypt(after.data.clientSecret),"a-secret");assert.equal(decrypt(after.data.privateKey),"a-key");
    const [{n:countBefore}]=await db.query("SELECT COUNT(*)::text AS n FROM autosnap_records");
    await assert.rejects(saveConnection(db,{name:"Incomplete",client:{clientId:"other-client"},environment:{mode:"live",baseUrl:"https://sandbox.example"}}),error=>error.status===400);
    const [{n:countAfter}]=await db.query("SELECT COUNT(*)::text AS n FROM autosnap_records");assert.equal(countAfter,countBefore);
    await assert.rejects(saveConnection(db,{name:"Duplicate",userId:snapUserId,client:{clientId:"client-qa"},environment:{mode:"mock"}}),error=>error.status===409);
    await assert.rejects(db.transaction(async query=>{await query("UPDATE autosnap_records SET name='SHOULD ROLLBACK' WHERE id=$1",[created.id]);throw Error("stop");}),/stop/);
    const [rolledBack]=await db.query("SELECT name FROM autosnap_records WHERE id=$1",[created.id]);assert.equal(rolledBack.name,"Sandbox Renamed");
    const b2b2c=await saveConnection(db,{environmentId:created.id,userId:snapUserId,client:{deviceId:"device"},environment:{useCase:"B2B2C"}});
    assert.ok(b2b2c.userId);
    const [consumer]=await db.query("SELECT * FROM autosnap_records WHERE id=$1",[b2b2c.userId]);assert.equal(consumer.parent_id,null);assert.equal(consumer.data.customerToken,undefined,"token must come from the Security flow, not connection input");
    const [linked]=await db.query("SELECT data FROM autosnap_records WHERE id=$1",[created.id]);assert.equal(linked.data.defaultUserId,consumer.id);
  }finally{await db.onModuleDestroy();}
});

test("testing starts with explicit choices, no hidden target or manual token input",()=>{
  const Testing=component("app/testing.tsx");
  const records=[
    {id:"client",kind:"client",name:"Client",data:{clientId:"client-key"}},
    {id:"project",kind:"project",name:"Project",parentId:"client",data:{}},
    {id:"env",kind:"environment",name:"Sandbox",parentId:"project",data:{mode:"live",useCase:"B2B",baseUrl:"https://sandbox.example",authFlow:"token_b2b"}},
    {id:"service",kind:"service",name:"Balance Inquiry",data:{module:"Informasi Saldo",code:"11"}},
    {id:"endpoint",kind:"endpoint",name:"Balance Inquiry",parentId:"service",data:{method:"POST",path:"/api/v1.0/balance-inquiry"}},
    {id:"template",kind:"template",name:"Default",parentId:"endpoint",data:{body:JSON.stringify({partnerReferenceNo:"{{partner_reference_no}}",accountNo:"2000100101",additionalInfo:{}})}}
  ];
  const html=renderToStaticMarkup(createElement(Testing,{state:{records,runs:[],scenarios:[]},api:async()=>({}),reload:async()=>{},setError:()=>{},setNotice:()=>{}}));
  assert.match(html,/<span>Endpoint URL \*<\/span>/);assert.match(html,/<span>API Service \*<\/span>/);assert.match(html,/<span>User SNAP \*<\/span>/);assert.match(html,/<span>Dev Site Client \*<\/span>/);
  assert.match(html,/CHANNEL-ID/);assert.match(html,/History Testing/);assert.match(html,/Jalankan Testing/);
  assert.match(html,/disabled=""/);assert.doesNotMatch(html,/2000100101/,"a sample account is not selected before choosing a service");
  assert.doesNotMatch(html,/<span>Project<\/span>|Request Template|Access Token B2B/);
});

test("a Dev Site draft requires an owner, uses a direct API URL and has editable default channel",()=>{
  const ConnectionForm=component("app/connection-form.tsx");
  const html=renderToStaticMarkup(createElement(ConnectionForm,{api:async()=>({}),reload:async()=>{},onSaved:()=>{},onClose:()=>{}}));
  assert.match(html,/User SNAP \*/);assert.match(html,/Nama Dev Site Client/);assert.doesNotMatch(html,/URL Aplikasi Pengujian Access Token B2B|Encoding RSA|Encoding HMAC|Public Key client/);assert.match(html,/>Simpan</);
  assert.match(html,/value="95221"/);assert.doesNotMatch(html,/Target pengujian|Simulasi lokal/);
  assert.doesNotMatch(html,/sandbox/i);
  assert.doesNotMatch(html,/<span>Access Token|provided_token|rekening konsumen/);
});
