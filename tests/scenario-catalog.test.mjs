import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const catalog=JSON.parse(await readFile(new URL("../app/scenario-catalog.json",import.meta.url),"utf8"));
const services=JSON.parse(await readFile(new URL("../app/snap-spec-catalog.json",import.meta.url),"utf8"));

test("SNAP specification catalog includes 81 unique service codes and endpoint paths",()=>{
  assert.equal(services.length,81);
  assert.equal(new Set(services.map(x=>x.code)).size,81);
  for(const item of services){
    assert.match(item.code,/^\d{2}$/);
    assert.match(item.endpoint,/^\/api\/v1\.0\/[A-Za-z0-9/_-]+$/);
    assert.doesNotMatch(item.name,/�/);
  }
  assert.equal(services.find(x=>x.code==="11")?.endpoint,"/api/v1.0/balance-inquiry");
  assert.equal(services.find(x=>x.code==="54")?.endpoint,"/api/v1.0/debit/payment-host-to-host");
  assert.equal(services.find(x=>x.code==="46")?.name,"Transfer to OTC – Cancel Payment");
});

test("functional test workbook scenarios are available with unique IDs and response codes",()=>{
  assert.equal(catalog.length,320);
  assert.equal(new Set(catalog.map(x=>x.id)).size,320);
  assert.equal(new Set(catalog.map(x=>x.group)).size,22);
  for(const item of catalog){
    assert.match(item.id,/^\d+\.\d+$/);
    assert.match(item.expectedCode,/^\d{3}(?:\d{2}|xx)\d{2}$/);
    assert.ok(item.scenario.length>0);
    assert.ok(item.expected.length>0);
    assert.doesNotMatch(`${item.group} ${item.service} ${item.scenario} ${item.expected}`,/�/);
  }
});

test("positive and negative Balance Inquiry cases keep their exact expected codes",()=>{
  assert.equal(catalog.find(x=>x.id==="3.6")?.expectedCode,"2001100");
  assert.equal(catalog.find(x=>x.id==="3.1")?.expectedCode,"401xx01");
  assert.equal(catalog.find(x=>x.id==="3.5")?.expectedCode,"409xx00");
});

test("Direct Debit cases include success and insufficient funds",()=>{
  assert.equal(catalog.find(x=>x.id==="19.6")?.expectedCode,"2005400");
  assert.equal(catalog.find(x=>x.id==="19.8")?.expectedCode,"4035414");
});
