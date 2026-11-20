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
  const {assertSafeSignerUrl}=await loadSigning();
  process.env.AUTOSNAP_SIGNER_ALLOWLIST="signer.example.com";
  assert.throws(()=>assertSafeSignerUrl("http://signer.example.com/sign"),(err)=>/HTTPS/i.test(err?.error));
  assert.throws(()=>assertSafeSignerUrl("https://127.0.0.1/sign"),(err)=>/tidak diizinkan/i.test(err?.error));
  assert.throws(()=>assertSafeSignerUrl("https://evil.example.com/sign"),(err)=>/allowlist/i.test(err?.error));
  assert.equal(assertSafeSignerUrl("https://signer.example.com/sign").hostname,"signer.example.com");
});
