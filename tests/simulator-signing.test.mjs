import assert from "node:assert/strict";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(import.meta.url);

// Compile-free import of TS via ts-node/register if available; otherwise load built dist.
async function loadSigning(){
  try{
    return await import(pathToFileURL(join(root,"backend","dist","simulator-signing.js")).href);
  }catch{
    process.env.TS_NODE_TRANSPILE_ONLY="1";
    require("ts-node/register/transpile-only");
    return require(join(root,"backend","src","simulator-signing.ts"));
  }
}

test("isoTimestamp formats offset and optional millis",async()=>{
  const {isoTimestamp}=await loadSigning();
  const fixed=new Date("2026-11-19T10:35:00.123Z");
  assert.equal(isoTimestamp({offsetMinutes:420,includeMillis:false},fixed),"2026-11-19T17:35:00+07:00");
  assert.equal(isoTimestamp({offsetMinutes:420,includeMillis:true},fixed),"2026-11-19T17:35:00.123+07:00");
});

test("RSA-SHA256 access token and HMAC-SHA512 service signatures match encodings",async()=>{
  const {getXSignatureAccessTokenFunction,getXSignatureServiceFunction}=await loadSigning();
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
  const clientKey="test-client-key";
  const ts="2026-11-19T17:35:00+07:00";
  const b64=getXSignatureAccessTokenFunction(privateKey,clientKey,ts,"base64");
  const hex=getXSignatureAccessTokenFunction(privateKey,clientKey,ts,"hex");
  assert.ok(b64.length>20);
  assert.ok(/^[0-9a-f]+$/i.test(hex));
  assert.notEqual(b64,hex);
  createPrivateKey(privateKey);

  const secret="client-secret-vector";
  const body='{"partnerReferenceNo":"123"}';
  const svcHex=getXSignatureServiceFunction(secret,"POST","/api/v1.0/transfer", "token-abc", body, ts, "hex");
  const svcB64=getXSignatureServiceFunction(secret,"POST","/api/v1.0/transfer", "token-abc", body, ts, "base64");
  assert.equal(svcHex.length,128);
  assert.ok(svcB64.length>20);
  assert.notEqual(svcHex,svcB64);
});

test("HIT_API signer URL rejects non-HTTPS and private hosts",async()=>{
  const {assertSafeSignerUrl,aspiSignatureTarget,resolveSignerUrl}=await loadSigning();
  const previous=process.env.AUTOSNAP_SIGNER_ALLOWLIST;
  delete process.env.AUTOSNAP_SIGNER_ALLOWLIST;
  assert.equal(assertSafeSignerUrl("https://signer.example.com/sign").hostname,"signer.example.com");
  process.env.AUTOSNAP_SIGNER_ALLOWLIST="signer.example.com";
  assert.throws(()=>assertSafeSignerUrl("http://signer.example.com/sign"),(err)=>/HTTPS/i.test(err?.error));
  assert.throws(()=>assertSafeSignerUrl("https://127.0.0.1/sign"),(err)=>/tidak diizinkan/i.test(err?.error));
  assert.throws(()=>assertSafeSignerUrl("https://evil.example.com/sign"),(err)=>/allowlist/i.test(err?.error));
  assert.equal(assertSafeSignerUrl("https://signer.example.com/sign").hostname,"signer.example.com");
  const {joinProviderUrl,normalizeEndpointPath}=await loadSigning();
  assert.equal(joinProviderUrl("https://dev.banksumut.co.id","/snapgov/api/v1.0/utilities/signature-service"),"https://dev.banksumut.co.id/snapgov/api/v1.0/utilities/signature-service");
  assert.equal(joinProviderUrl("https://dev.banksumut.co.id/snapgov","/api/v1.0/utilities/signature-service"),"https://dev.banksumut.co.id/snapgov/api/v1.0/utilities/signature-service");
  assert.equal(normalizeEndpointPath("https://dev.banksumut.co.id/snapgov/api/v1.0/utilities/signature-service","https://dev.banksumut.co.id"),"/snapgov/api/v1.0/utilities/signature-service");
  assert.equal(normalizeEndpointPath("https://dev.banksumut.co.id/snapgov/api/v1.0/utilities/signature-service","https://dev.banksumut.co.id/snapgov"),"/api/v1.0/utilities/signature-service");
  assert.equal(normalizeEndpointPath("https://token.test/access-token","https://dev.banksumut.co.id"),"https://token.test/access-token");
  assert.equal(resolveSignerUrl("/snapgov/api/v1.0/utilities/signature-service","https://dev.banksumut.co.id"),"https://dev.banksumut.co.id/snapgov/api/v1.0/utilities/signature-service");
  assert.equal(resolveSignerUrl("https://dev.banksumut.co.id/snapgov/api/v1.0/utilities/signature-service","https://dev.banksumut.co.id"),"https://dev.banksumut.co.id/snapgov/api/v1.0/utilities/signature-service");
  assert.throws(()=>joinProviderUrl("","/utilities/signature-service"),(err)=>/Base URL/i.test(err?.error));
  assert.equal(aspiSignatureTarget("https://apidevportal.aspi-indonesia.or.id/api-services/keamanan","auth").path,"/api/v1.0/utilities/signature-auth");
  assert.equal(aspiSignatureTarget("https://apidevportal.aspi-indonesia.or.id/api-services/keamanan","service").path,"/api/v1.0/utilities/signature-service");
  assert.equal(aspiSignatureTarget("https://signer.example.com/sign","auth"),null);
  const {snapUtilityKind,snapUtilityRequest,toAspiPrivateKey}=await loadSigning();
  assert.equal(snapUtilityKind("https://dev.banksumut.co.id/snapgov/api/v1.0.0/utilities/signature-auth"),"auth");
  assert.equal(snapUtilityKind("https://apidevportal.aspi-indonesia.or.id/api-services/keamanan"),null);
  assert.equal(snapUtilityKind("https://signer.example.com/api/v1.0/utilities/signature-service"),"service");
  const auth=snapUtilityRequest("auth",{timestamp:"2026-11-25T10:41:00+07:00",clientKey:"client",privateKey:"AAAA"});
  assert.equal(auth.body,undefined);
  assert.equal(auth.headers.Private_Key,"AAAA");
  assert.equal("privateKey" in auth.headers,false);
  const service=snapUtilityRequest("service",{timestamp:"2026-11-25T10:41:00+07:00",clientSecret:"secret",method:"POST",endpoint:"/api/v1.0.0/transfer-va/create-vagov",accessToken:"token",bodyText:"{}"});
  assert.equal(service.headers.EndpoinUrl,"/api/v1.0.0/transfer-va/create-vagov");
  assert.equal(service.headers.EndpointUrl,"/api/v1.0.0/transfer-va/create-vagov");
  assert.equal(service.body,"{}");
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  const pem=privateKey.export({type:"pkcs8",format:"pem"}).toString();
  const pkcs1=privateKey.export({type:"pkcs1",format:"der"}).toString("base64");
  assert.equal(toAspiPrivateKey(pem),pkcs1);
  assert.equal(toAspiPrivateKey(pkcs1),pkcs1);
  assert.equal(pem.includes("BEGIN"),true);
  assert.equal(pkcs1.includes("BEGIN"),false);
  assert.equal(aspiSignatureTarget("https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_utilities_signature_auth","auth").path,"/api/v1.0/utilities/signature-auth");
  assert.throws(()=>toAspiPrivateKey("A".repeat(50)),(err)=>/belum berupa kunci/i.test(err?.error));
  if(previous===undefined)delete process.env.AUTOSNAP_SIGNER_ALLOWLIST;else process.env.AUTOSNAP_SIGNER_ALLOWLIST=previous;
});
