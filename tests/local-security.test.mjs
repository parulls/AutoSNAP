import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const require=createRequire(import.meta.url);
const {ensureLocalEncryptionKey,initializeLocalSecurity}=require("../backend/dist/local-security.js");
const {DatabaseService}=require("../backend/dist/database.service.js");
const directory=t=>{const dir=mkdtempSync(join(tmpdir(),"autosnap-security-test-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

test("first local startup persists a random key and later startups reuse it without changing other settings",t=>{
  const dir=directory(t),envPath=join(dir,".env.local");
  writeFileSync(envPath,"AUTOSNAP_ALLOWED_HOSTS=sandbox.example\nCUSTOM_VALUE=keep-me\n");
  const environment={NODE_ENV:"development"};
  assert.equal(ensureLocalEncryptionKey({projectDir:dir,hasStoredCredentials:false,environment}),"created");
  assert.equal(Buffer.from(environment.AUTOSNAP_ENCRYPTION_KEY,"base64").length,32);
  const content=readFileSync(envPath,"utf8");assert.match(content,/CUSTOM_VALUE=keep-me/);assert.equal(existsSync(join(dir,".autosnap-security.lock")),false);
  const reloaded={NODE_ENV:"development"};
  assert.equal(ensureLocalEncryptionKey({projectDir:dir,hasStoredCredentials:true,environment:reloaded}),"file");
  assert.equal(reloaded.AUTOSNAP_ENCRYPTION_KEY,environment.AUTOSNAP_ENCRYPTION_KEY);
  assert.equal(readFileSync(envPath,"utf8"),content);
});

test("configured external keys are honored; missing or invalid keys never rotate old ciphertext",t=>{
  const dir=directory(t),value=randomBytes(32).toString("base64");
  assert.equal(ensureLocalEncryptionKey({projectDir:dir,hasStoredCredentials:true,environment:{AUTOSNAP_ENCRYPTION_KEY:value}}),"environment");
  assert.equal(existsSync(join(dir,".env.local")),false);
  assert.throws(()=>ensureLocalEncryptionKey({projectDir:dir,hasStoredCredentials:true,environment:{}}),/Pulihkan/);
  assert.throws(()=>ensureLocalEncryptionKey({projectDir:dir,hasStoredCredentials:false,environment:{AUTOSNAP_ENCRYPTION_KEY:"bad-key"}}),/tidak valid/);
  assert.throws(()=>ensureLocalEncryptionKey({projectDir:dir,hasStoredCredentials:false,environment:{NODE_ENV:"production"}}),/produksi/);
  assert.equal(existsSync(join(dir,".env.local")),false);
});

test("bootstrap examines the database before generating a replacement key",async t=>{
  const dir=directory(t);delete process.env.DATABASE_URL;process.env.AUTOSNAP_PGLITE_DIR="memory://";
  const db=new DatabaseService();await db.onModuleInit();
  try{
    const environment={NODE_ENV:"development"};
    assert.equal(await initializeLocalSecurity(db,dir,environment),"created");
    await db.query("INSERT INTO autosnap_records (id,kind,name,data,created_at,updated_at) VALUES ('old','client','Existing',$1::jsonb,'now','now')",[JSON.stringify({clientSecret:"existing-ciphertext"})]);
    unlinkSync(join(dir,".env.local"));
    await assert.rejects(initializeLocalSecurity(db,dir,{NODE_ENV:"development"}),/Pulihkan/);
    assert.equal(existsSync(join(dir,".env.local")),false);
  }finally{await db.onModuleDestroy();}
});
