import {createRequire as __createRequireHttp} from "node:module";
const __requireHttp=__createRequireHttp(import.meta.url);
const {RunEvidenceService}=__requireHttp("../backend/dist/run-evidence.js");
import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
const require=createRequire(import.meta.url);
const {DatabaseService}=require("../backend/dist/database.service.js");
const {AutoSnapController}=require("../backend/dist/app.js");
const {createAccount}=require("../backend/dist/accounts.js");
const {RunControl}=require("../backend/dist/run-control.js");
const {PortalEngine}=require("../backend/dist/portal-engine.js");
const {AspiSessionManager}=require("../backend/dist/aspi-session-manager.js");

test("durable cancel is owner-scoped, aborts another instance, and preserves progress events",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";
  const db=new DatabaseService();await db.onModuleInit();
  let control;
  try{
    const a=await createAccount(db,{username:"cancel-a",email:"cancel-a@example.test",password:"test-password-123"},"tester",true);
    const b=await createAccount(db,{username:"cancel-b",email:"cancel-b@example.test",password:"test-password-123"},"tester",true);
    const id=randomUUID();await db.query("INSERT INTO autosnap_test_progress(id,user_id,status,stage,steps,updated_at) VALUES($1,$2,'running','signature_auth','[]'::jsonb,$3)",[id,a,new Date().toISOString()]);
    const controller=new AutoSnapController(db, null, null, null, new RunEvidenceService(db, null));let actor=a;
    controller.user=async()=>({id:actor,role:"tester",privileges:["dev_site"]});controller.enforceRateLimit=async()=>{};
    const call=async()=>{const res={code:200,status(n){this.code=n;return this;},json(body){return {code:this.code,body};}};return controller.action({body:{action:"cancelRun",id},headers:{}},res);};
    actor=b;assert.equal((await call()).code,409);assert.equal((await db.one("SELECT status FROM autosnap_test_progress WHERE id=$1",[id])).status,"running");
    control=new RunControl(db,id,a);await control.start();actor=a;assert.equal((await call()).code,200);
    await new Promise(resolve=>setTimeout(resolve,650));assert.equal(control.signal.aborted,true);
    await controller.updateProgress(id,a,"signature_auth","failed","Browser dihentikan.");
    let row=await db.one("SELECT * FROM autosnap_test_progress WHERE id=$1",[id]);assert.equal(row.status,"cancel_requested");assert.equal(row.steps.length,2);
    await controller.updateProgress(id,a,"finished","completed","A late completion must not override accepted Cancel.");
    row=await db.one("SELECT * FROM autosnap_test_progress WHERE id=$1",[id]);assert.equal(row.status,"cancelled");assert.equal(row.steps.length,3);
    assert.equal((await call()).code,409,"completed runs cannot be cancelled again");
  }finally{control?.stop();await db.onModuleDestroy();}
});

test("cancel before headless startup never opens an ASPI browser",async()=>{
  const abort=new AbortController();abort.abort();let opens=0;
  const portal=new PortalEngine({getAuthenticatedContext:async()=>{opens++;throw Error("must not open");}},null);
  const result=await portal.hit({signal:abort.signal,extraHeaders:{},method:"POST",path:"/api/v1.0/balance-inquiry",body:{},externalId:"test-cancel"});
  assert.equal(result.outcome,"CANCELLED");assert.equal(result.status,null);assert.equal(opens,0);
});

test("cancel closes an active ASPI context and releases its session lease",async()=>{
  const manager=new AspiSessionManager(),abort=new AbortController();let closed=0,rejectNavigation;
  manager.openContext=async()=>({pages:()=>[{}],close:async()=>{closed++;rejectNavigation?.(Error("Navigation cancelled"));}});
  const pending=manager.getAuthenticatedContext({data:{email:"cancel@example.test"}},"aspi",async()=>new Promise((resolve,reject)=>{rejectNavigation=reject;}),abort.signal);
  await new Promise(resolve=>setTimeout(resolve,10));abort.abort();await assert.rejects(pending,/cancelled/);assert.ok(closed>0);
  const next=await manager.getAuthenticatedContext({data:{email:"cancel@example.test"}},"aspi",async()=>true);await next.release();
});
