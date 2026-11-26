import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "backend/src/master-data-list.ts"), "utf8");
const app = readFileSync(join(root, "backend/src/app.ts"), "utf8");
const session = readFileSync(join(root, "backend/src/aspi-session-manager.ts"), "utf8");
const portal = readFileSync(join(root, "backend/src/portal-engine.ts"), "utf8");
const testing = readFileSync(join(root, "app/testing-panel.tsx"), "utf8");
const master = readFileSync(join(root, "app/master-data.tsx"), "utf8");

test("listMasterData clamps pageSize and supports soft-link filter", () => {
  assert.match(src, /Math\.min\(50/);
  assert.match(src, /linkedOnly/);
  assert.match(src, /linkedServiceIds/);
  assert.match(src, /sim_service/);
  assert.match(app, /action==="listMasterData"/);
  assert.match(app, /action==="linkClientServices"/);
  assert.match(app, /appendServiceIds/);
});

test("Master Data FE uses listMasterData, IconButton, and client detail", () => {
  assert.match(master, /listMasterData/);
  assert.match(master, /IconButton/);
  assert.match(master, /DevSiteClientDetail/);
  assert.match(master, /PaginationBar/);
  assert.match(master, /DataTable/);
  assert.match(master, /Tambah \$\{labels\[kind\]\}/);
});

test("Lainnya custom scenario is validated on FE and BE", () => {
  assert.match(testing, /Lainnya \(custom\)/);
  assert.match(testing, /customOverride/);
  assert.match(testing, /Expected SNAP Code/);
  assert.match(app, /"custom"/);
  assert.match(app, /customOverride/);
  assert.match(app, /Expected SNAP Code Lainnya harus 7 digit/);
  assert.match(app, /Expected HTTP Lainnya harus 100–599/);
});

test("ASPI relogin is limited to safe evidence stages", () => {
  assert.match(session, /renewSessionIfExpired/);
  assert.match(session, /ASPI session renewed/);
  assert.match(session, /maxAttempts/);
  assert.match(portal, /renewSessionIfExpired/);
  assert.match(portal, /Evidence-only renew/);
  assert.doesNotMatch(portal, /renewSessionIfExpired[\s\S]{0,200}Execute/i);
});
