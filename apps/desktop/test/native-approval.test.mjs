import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "esbuild";
import { hasSupportedCapabilityDeclaration, requestCapabilityGroups } from "../src/renderer/application-capabilities.ts";

// Render the real consent component without Electron, a browser, or network.
const source = await readFile(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
const component = source.slice(source.indexOf("function PortalApprovalRequest("), source.indexOf("\nfunction ApplicationGrantGroup("));
const compiled = await transform(component, { loader: "tsx", format: "cjs" });
const Approval = new Function("React", "useState", "hasSupportedCapabilityDeclaration", "requestCapabilityGroups", "host", "relativeTime", "RequestPermissionChoices", "NotificationAccess", `${compiled.code}; return PortalApprovalRequest;`)(
  React, React.useState, hasSupportedCapabilityDeclaration, requestCapabilityGroups,
  () => "example.test", () => "in ten minutes",
  ({ groups }) => React.createElement("span", null, groups.map((group) => group.label).join(" · ")),
  () => null
);
const collection = { id: "local", display_name: "Notes", enabled: true };
const request = {
  id: "request", application_name: "Reader", application_distribution: "web", application_homepage: "https://example.test",
  expires_at: "2099-01-01T00:00:00Z", compatible_collection_ids: ["local"], provisionable_collection_ids: [],
  requested_operations: ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type"],
  requirements: { contracts: [], capabilities: { contract_version: 2, required: ["collection.read"] } },
  provisions: { type_packs: [] }, notifications: { criteria: [] }
};
function render(overrides = {}, collections = [collection]) {
  return renderToStaticMarkup(React.createElement(Approval, { request: { ...request, ...overrides }, collections, busy: false,
    onAct: () => { throw new Error("Rendering a snapshot must never authorize"); } }));
}

test("native consent names the local collection, full scope, capabilities, revocation, and explicit decision", () => {
  const html = render();
  assert.match(html, /Entire collection/);
  assert.match(html, /Read this collection/);
  assert.match(html, /until revoked/);
  assert.match(html, /<option value="local" selected="">Notes/);
  assert.match(html, />Deny<\/button>/);
  assert.match(html, /<button class="button primary">Allow Reader<\/button>/);
  assert.doesNotMatch(html, /Review in Connect/);
});

test("multiple collections require explicit selection", () => {
  const html = render({ compatible_collection_ids: ["local", "second"] }, [collection, { ...collection, id: "second" }]);
  assert.match(html, /<button class="button primary" disabled="">Allow Reader/);
  assert.match(html, /<option value="" disabled="" selected="">Choose a collection/);
});

for (const [name, overrides, collections] of [
  ["different requested collection", { collection_id: "other" }],
  ["disabled collection", {}, [{ ...collection, enabled: false }]],
  ["missing capability version", { requirements: { contracts: [] } }],
  ["type setup", { provisions: { type_packs: [{}] } }],
  ["configuration setup", { provisions: { type_packs: [], configuration: [{}] } }]
]) test(`${name} retains the supported detailed review`, () => {
  const html = render(overrides, collections);
  assert.match(html, /Review in Connect/);
  assert.doesNotMatch(html, /Allow Reader/);
});

test("file ceilings and selected folder scope remain visible at consent", () => {
  const html = render({ requirements: { ...request.requirements, files: { required: ["list", "read"], optional: ["delete"], scope: { kind: "selected_folders", folders: ["attachments"] } } } });
  assert.match(html, /Files: list, read, delete/);
  assert.match(html, /Scope: attachments/);
});

const mainSource = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
const ipcSource = mainSource.slice(mainSource.indexOf('  ipcMain.handle("connect:authorizations:approve"'), mainSource.indexOf('  ipcMain.handle("connect:grants:create"'));
const ipcCompiled = await transform(ipcSource, { loader: "ts", format: "cjs" });
function ipcFixture() {
  const handlers = new Map();
  const calls = [];
  new Function("ipcMain", "trustedIpc", "asObject", "requestReadyAgent", ipcCompiled.code)(
    { handle: (channel, callback) => handlers.set(channel, callback) },
    (event) => { if (event !== "trusted") throw new Error("Untrusted renderer"); },
    (value) => { if (!value || typeof value !== "object") throw new Error("Invalid input"); return value; },
    async (...args) => { calls.push(args); return { ok: true }; }
  );
  return { handlers, calls };
}

test("trusted native approval dispatches the chosen request and permissions to local control", async () => {
  const { handlers, calls } = ipcFixture();
  await handlers.get("connect:authorizations:approve")("trusted", { requestId: "request", collectionId: "local", operations: ["read"] });
  assert.deepEqual(calls, [["authorizations.approve", { request_id: "request", collection_id: "local", operations: ["read"], contract_setups: [] }, 75_000]]);
});

test("untrusted or malformed native decisions never reach local control", async () => {
  const { handlers, calls } = ipcFixture();
  await assert.rejects(handlers.get("connect:authorizations:approve")("untrusted", {}), /Untrusted/);
  await assert.rejects(handlers.get("connect:authorizations:approve")("trusted", { requestId: "request", collectionId: "local", operations: [42] }), /Choose/);
  await assert.rejects(handlers.get("connect:authorizations:deny")("untrusted", "request"), /Untrusted/);
  assert.deepEqual(calls, []);
});
