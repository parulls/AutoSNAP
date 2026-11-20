import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AutoSnapController } = require("../backend/dist/app.js");

test("PostgreSQL 42703 maps to DATABASE_SCHEMA_ERROR instead of opaque 500", async () => {
  const controller = new AutoSnapController({}, null, null, null, null);
  const res = {
    code: 200,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  controller.fail(res, { code: "42703", message: 'column "content_sha256" does not exist' });
  assert.equal(res.code, 503);
  assert.equal(res.body.code, "DATABASE_SCHEMA_ERROR");
  assert.match(res.body.error, /migrasi|skema|kolom/i);
  assert.equal(res.body.code === "42703", false);
});
