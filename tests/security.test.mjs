import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {requireTrustedProxy}=require("../backend/dist/http-security.js");
const {checkHeaders}=require("../backend/dist/run-engine.js");
const {redact}=require("../backend/dist/security.js");
const {DatabaseService}=require("../backend/dist/database.service.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {AspiSessionManager}=require("../backend/dist/aspi-session-manager.js");

test("production backend fails closed and does not trust spoofed proxy headers",()=>{
  const nodeEnv=process.env.NODE_ENV,secret=process.env.AUTOSNAP_INTERNAL_TOKEN;
  process.env.NODE_ENV="production";delete process.env.AUTOSNAP_INTERNAL_TOKEN;
  const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){return body;}};
  let forwarded=false;
  try{
    requireTrustedProxy({headers:{"x-autosnap-host":"localhost"}},res,()=>{forwarded=true;});
    assert.equal(res.code,503);assert.equal(forwarded,false);
    process.env.AUTOSNAP_INTERNAL_TOKEN="a".repeat(64);
    requireTrustedProxy({headers:{"x-autosnap-internal-token":"wrong"}},res,()=>{forwarded=true;});
    assert.equal(res.code,403);assert.equal(forwarded,false);
    requireTrustedProxy({headers:{"x-autosnap-internal-token":"a".repeat(64)}},res,()=>{forwarded=true;});
    assert.equal(forwarded,true);
  }finally{if(nodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=nodeEnv;if(secret===undefined)delete process.env.AUTOSNAP_INTERNAL_TOKEN;else process.env.AUTOSNAP_INTERNAL_TOKEN=secret;}
});

test("template headers cannot override managed headers or inject cookies and CRLF",()=>{
  for(const key of ["Authorization","X-Signature","Host","Cookie","Content-Length"]){assert.throws(()=>checkHeaders({[key]:"bad"}));}
  assert.throws(()=>checkHeaders({"X-Custom":"value\r\nCookie: bad"}));
  assert.doesNotThrow(()=>checkHeaders({"X-Custom":"safe"}));
  assert.deepEqual(redact({cookie:"session",setCookie:"session",accountNo:"123",body:{accessToken:"secret"}}),{cookie:"[REDACTED]",setCookie:"[REDACTED]",accountNo:"[REDACTED]",body:{accessToken:"[REDACTED]"}});
});

test("login limits persist across controllers and stored keys contain no usernames",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";
  const db=new DatabaseService();await db.onModuleInit();
  const first=new AutoSnapController(db),second=new AutoSnapController(db);
  try{
    for(let i=0;i<3;i++)await first.enforceRateLimit("private@example.com",5,60000);
    for(let i=0;i<2;i++)await second.enforceRateLimit("private@example.com",5,60000);
    await assert.rejects(second.enforceRateLimit("private@example.com",5,60000),error=>error.status===429);
    const rows=await db.query("SELECT key,attempts FROM autosnap_rate_limits");
    assert.equal(rows.length,1);assert.match(rows[0].key,/^[a-f0-9]{64}$/);assert.equal(rows[0].attempts,6);
  }finally{await db.onModuleDestroy();}
});

test("ASPI session lock spans backend instances and releases only its own lease",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";
  const db=new DatabaseService();await db.onModuleInit();
  const first=new AspiSessionManager(db),second=new AspiSessionManager(db);
  const user={data:{email:"qa@example.com"}};
  let closed=0;
  first.openContext=second.openContext=async()=>({pages:()=>[{}],close:async()=>{closed++;}});
  try{
    const session=await first.getAuthenticatedContext(user,"aspi",async()=>true);
    await assert.rejects(second.getAuthenticatedContext(user,"aspi",async()=>true),/sedang digunakan/);
    assert.equal((await db.query("SELECT * FROM autosnap_automation_leases")).length,1);
    await session.release();
    const next=await second.getAuthenticatedContext(user,"aspi",async()=>true);await next.release();
    assert.equal((await db.query("SELECT * FROM autosnap_automation_leases")).length,0);assert.equal(closed,2);
  }finally{await db.onModuleDestroy();}
});
