import assert from "node:assert/strict";
import test from "node:test";
import { fieldOf, linkDevSite, sentHeaderField } from "../app/dev-site-link.ts";

const client = { id: "client", kind: "client", name: "SNAP Bank Sumut", parentId: null, data: { deviceId: "web", channelId: "95221" } };
const project = { id: "project", kind: "project", name: "SNAP Bank Sumut", parentId: "client", data: {} };
const site = { id: "site", kind: "environment", name: "SNAP Bank Sumut", parentId: "project", data: { category: "Dev Site", mode: "portal" } };

test("Dev Site header fields come from the linked client", () => {
  const linked = linkDevSite([site, project, client], site);
  assert.equal(linked.client?.id, "client");
  assert.equal(fieldOf(linked.client, "deviceId"), "web");
  assert.equal(fieldOf(linked.client, "channelId"), "95221");
  assert.equal(fieldOf(linked.client, "origin"), "");
});

test("Dev Site record supplies X-DEVICE-ID when the client field is empty", () => {
  const linked = linkDevSite([site, project, { ...client, data: { channelId: "95221" } }], { ...site, data: { ...site.data, deviceId: "web" } });
  assert.equal(sentHeaderField(linked.client, linked.site, "deviceId"), "web");
  assert.equal(sentHeaderField(linked.client, linked.site, "channelId"), "95221");
});

test("parent_id is accepted when parentId is absent", () => {
  const legacyProject = { ...project, parentId: undefined, parent_id: "client" };
  const legacySite = { ...site, parentId: undefined, parent_id: "project" };
  const linked = linkDevSite([legacySite, legacyProject, client], legacySite);
  assert.equal(fieldOf(linked.client, "deviceId"), "web");
});
