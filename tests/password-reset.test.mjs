import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {DatabaseService}=require("../backend/dist/database.service.js");
const {createAccount,verifyPassword}=require("../backend/dist/accounts.js");
const {requestPasswordReset,resetPasswordWithOtp}=require("../backend/dist/password-reset.js");

test("email OTP resets password once, expires sessions and never stores the OTP",async()=>{
  process.env.NODE_ENV="test";process.env.AUTOSNAP_TEST_PGLITE="memory://";
  process.env.AUTOSNAP_PASSWORD_RESET_SECRET="reset-test-secret-that-is-longer-than-32-characters";
  process.env.RESEND_API_KEY="resend-test";process.env.AUTOSNAP_EMAIL_FROM="AutoSNAP <test@example.test>";
  const savedFetch=globalThis.fetch;let otp="";
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),"https://api.resend.com/emails");
    const body=JSON.parse(String(options.body));otp=String(body.html).match(/>(\d{6})</)?.[1]??"";
    return {ok:true};
  };
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const userId=await createAccount(db,{username:"reset-user",email:"reset@example.test",password:"old-password-123"},"petugas",true);
    await db.query("INSERT INTO autosnap_sessions (hash,user_id,expires_at) VALUES ('session',$1,$2)",[userId,new Date(Date.now()+60_000).toISOString()]);
    const request=await requestPasswordReset(db,"RESET@example.test");
    assert.match(otp,/^\d{6}$/);assert.ok(request.resetId);
    assert.equal(JSON.stringify(await db.query("SELECT * FROM autosnap_password_resets")).includes(otp),false);
    await assert.rejects(resetPasswordWithOtp(db,{resetId:request.resetId,otp:"000000",password:"new-password-123"}),error=>error.status===400);
    await resetPasswordWithOtp(db,{resetId:request.resetId,otp,password:"new-password-123"});
    assert.equal((await db.query("SELECT * FROM autosnap_sessions")).length,0);
    const user=await db.one("SELECT salt,password_hash FROM autosnap_users WHERE id=$1",[userId]);
    assert.equal(await verifyPassword("new-password-123",user),true);
    await assert.rejects(resetPasswordWithOtp(db,{resetId:request.resetId,otp,password:"another-password-123"}),error=>error.status===400);
  }finally{globalThis.fetch=savedFetch;await db.onModuleDestroy();}
});
