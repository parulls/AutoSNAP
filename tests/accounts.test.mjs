import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {randomBytes} from "node:crypto";
const require=createRequire(import.meta.url);
const {DatabaseService}=require("../backend/dist/database.service.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {RunEngine}=require("../backend/dist/run-engine.js");

test("signup verifies one-use CAPTCHA; pending accounts and testers cannot manage other users",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";process.env.AUTOSNAP_ENCRYPTION_KEY=randomBytes(32).toString("base64");
  process.env.AUTOSNAP_RECAPTCHA_SITE_KEY="test-site";process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY="test-secret";process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES="localhost";
  const used=new Set(),savedFetch=globalThis.fetch;
  globalThis.fetch=async(_url,options)=>{const token=new URLSearchParams(String(options.body)).get("response"),success=!!token&&token!=="expired"&&!used.has(token);if(success)used.add(token);return {ok:true,json:async()=>success?{success:true,hostname:"localhost"}:{success:false,"error-codes":["timeout-or-duplicate"]}};};
  const db=new DatabaseService();await db.onModuleInit();
  const controller=new AutoSnapController(db,new RunEngine());
  let session="";
  const invoke=async(action,payload={})=>{
    const request={headers:{cookie:session},hostname:"localhost",body:{action,...payload}};
    const response={code:200,status(n){this.code=n;return this;},json(body){return {status:this.code,body};},cookie(k,v){session=k+"="+v;},clearCookie(){session="";}};
    return controller.action(request,response);
  };
  const challenge=async()=>({recaptchaToken:randomBytes(12).toString("hex")});
  try{
    assert.equal((await invoke("setup",{username:"admin-qa",password:"long-password-123"})).status,400);
    assert.equal((await invoke("setup",{username:"admin-qa",password:"long-password-123",...await challenge()})).status,200);
    const adminSession=session;
    const admin=await db.one("SELECT * FROM autosnap_users WHERE username='admin-qa'");
    assert.equal(admin.role,"admin");assert.equal(admin.active,true);assert.notEqual(admin.password_hash,"long-password-123");
    const singleUse=await challenge();
    assert.equal((await invoke("register",{username:"qa-petugas",password:"long-password-123",...singleUse})).status,200);
    assert.equal((await invoke("register",{username:"qa-replay",password:"long-password-123",...singleUse})).status,400);
    const account=await db.one("SELECT * FROM autosnap_users WHERE username='qa-petugas'");
    assert.equal(account.active,false);assert.equal(account.role,"tester");
    assert.equal((await invoke("login",{username:"qa-petugas",password:"long-password-123"})).status,403);
    session=adminSession;
    assert.equal((await invoke("userUpdate",{id:account.id,active:true})).status,200);
    assert.equal((await invoke("login",{username:"qa-petugas",password:"long-password-123"})).status,200);
    assert.equal((await invoke("userCreate",{username:"intruder",password:"long-password-123",role:"admin"})).status,403);
    assert.equal((await invoke("userDelete",{id:admin.id})).status,403);
    assert.equal((await invoke("userUpdate",{id:admin.id,password:"new-password-123"})).status,403);
    assert.equal((await invoke("userUpdate",{id:account.id,role:"admin"})).status,403);
    assert.equal((await invoke("save",{kind:"snap_user",name:"Bad edit",data:{}})).status,403);
    const userState=await controller.state({headers:{cookie:session},hostname:"localhost"},{json:body=>body});
    assert.equal(userState.operators.length,1);assert.equal(userState.user.username,"qa-petugas");
    assert.ok(!JSON.stringify(userState).includes("password_hash"));
    assert.equal((await invoke("userUpdate",{id:account.id,password:"changed-password-123",currentPassword:"wrong"})).status,400);
    assert.equal((await invoke("userUpdate",{id:account.id,password:"changed-password-123",currentPassword:"long-password-123"})).status,200);
    assert.equal((await invoke("userCreate",{})).status,401,"password change revokes the session");
    assert.equal((await invoke("login",{username:"qa-petugas",password:"changed-password-123"})).status,200);
    session=adminSession;
    assert.equal((await invoke("userUpdate",{id:admin.id,active:false})).status,409);
    assert.equal((await invoke("userDelete",{id:admin.id})).status,409);
    assert.equal((await invoke("userUpdate",{id:account.id,active:false})).status,200);
    assert.equal((await invoke("login",{username:"qa-petugas",password:"changed-password-123"})).status,403);
    const expired={recaptchaToken:"expired"};
    assert.equal((await invoke("register",{username:"expired",password:"long-password-123",...expired})).status,400);
  }finally{globalThis.fetch=savedFetch;await db.onModuleDestroy();}
});
