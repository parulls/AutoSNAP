import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {normalizedParameterName}=require("../backend/dist/portal-engine.js");

test("Swagger parameter labels tolerate line breaks and required markers",()=>{
  assert.equal(normalizedParameterName("X-\n TIMESTAMP * required\nstring (header)"),"X-TIMESTAMP");
  assert.equal(normalizedParameterName("X-TIMESTAMP - e.g 2020-01-01T00:00:00+07:00"),"X-TIMESTAMP");
  assert.equal(normalizedParameterName("X-CLIENT-KEY - Please use your client id"),"X-CLIENT-KEY");
  assert.equal(normalizedParameterName("Private_Key - Please use your private key to get valid rsa key"),"PRIVATE_KEY");
  assert.equal(normalizedParameterName("Authorization-Customer * required"),"AUTHORIZATION-CUSTOMER");
  assert.notEqual(normalizedParameterName("Authorization-Customer"),normalizedParameterName("Authorization"));
});
