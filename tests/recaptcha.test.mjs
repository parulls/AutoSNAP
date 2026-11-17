import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {verifyRecaptcha}=require("../backend/dist/accounts.js");

test("reCAPTCHA keeps server verification, distinguishes bad secret and rejects foreign hostnames",async()=>{
  const oldFetch=globalThis.fetch,oldEnv={secret:process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY,hosts:process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES};
  process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY="fixture-secret";process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES="autosnap-web-two.vercel.app";
  let response={success:true,hostname:"autosnap-web-two.vercel.app"};
  globalThis.fetch=async(_url,options)=>{assert.equal(new URLSearchParams(options.body).get("secret"),"fixture-secret");return {ok:true,json:async()=>response};};
  try{
    await verifyRecaptcha({recaptchaToken:"fixture-token"});
    await assert.rejects(verifyRecaptcha({}),error=>error.status===400);
    response={success:false,"error-codes":["invalid-input-secret"]};await assert.rejects(verifyRecaptcha({recaptchaToken:"fixture-token"}),error=>error.status===503&&/secret/.test(error.error));
    response={success:false,"error-codes":["timeout-or-duplicate"]};await assert.rejects(verifyRecaptcha({recaptchaToken:"fixture-token"}),error=>error.status===400&&/kedaluwarsa/.test(error.error));
    response={success:true,hostname:"other.example"};await assert.rejects(verifyRecaptcha({recaptchaToken:"fixture-token"}),error=>error.status===403);
  }finally{globalThis.fetch=oldFetch;if(oldEnv.secret===undefined)delete process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY;else process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY=oldEnv.secret;if(oldEnv.hosts===undefined)delete process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES;else process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES=oldEnv.hosts;}
});
