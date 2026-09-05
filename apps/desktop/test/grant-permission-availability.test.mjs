import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "esbuild";
import { hasSupportedCapabilityDeclaration, requestCapabilityGroups } from "../src/renderer/application-capabilities.ts";

// Rust GrantSummary snapshots carry declaration identifiers, not requirements.
const grant = {
  id: "00000000-0000-4000-8000-000000000001",
  application_id: "00000000-0000-4000-8000-000000000002",
  application_declaration_id: "test-declaration",
  application_manifest_digest: "test-digest",
  application_name: "Test app",
  application_distribution: "web",
  application_homepage: "https://example.test",
  application_origin: "https://example.test",
  collection_id: "00000000-0000-4000-8000-000000000003",
  collection_name: "Test collection",
  operations: ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type", "update", "rename"],
  scope: { access: "full_collection", contracts: [] },
  notification_criteria: [],
  contracts: [],
  created_at: "2026-01-01T00:00:00Z"
};

// Render the actual isolated GrantEditor without booting Electron or the app root.
// This covers server rendering, not browser mounting or click dispatch.
const source = await readFile(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
const component = source.slice(source.indexOf("function GrantEditor("), source.indexOf("\nfunction Activity("));
const compiled = await transform(component, { loader: "tsx", format: "cjs" });
const GrantEditor = new Function("React", "useState", "useMemo", "useEffect", "hasSupportedCapabilityDeclaration", "requestCapabilityGroups", "host", "relativeTime", "RequestPermissionChoices", `${compiled.code}; return GrantEditor;`)(
  React, React.useState, React.useMemo, React.useEffect,
  hasSupportedCapabilityDeclaration, requestCapabilityGroups,
  () => "example.test", () => "recently",
  () => { throw new Error("Unavailable declarations must not render narrowing choices"); }
);

for (const [name, requirements] of [
  ["Rust snapshot without requirements", undefined],
  ["missing capability declaration", { contracts: [] }],
  ["unversioned declaration", { contracts: [], capabilities: { required: ["collection.read"] } }],
  ["unknown contract version", { contracts: [], capabilities: { contract_version: 99, required: ["collection.read"], optional: ["records.edit"] } }]
]) {
  test(`${name}: unavailable without inferring capabilities or revocation`, () => {
    assert.equal(hasSupportedCapabilityDeclaration(requirements), false);
    assert.deepEqual(requestCapabilityGroups(requirements, grant.operations), []);
    const snapshot = requirements === undefined ? grant : { ...grant, requirements };
    const html = renderToStaticMarkup(React.createElement(GrantEditor, {
      grant: snapshot, busy: false, onAct: async () => {}, onNotice: () => {}
    }));
    assert.match(html, /Permission details unavailable/);
    assert.match(html, /Access has not been changed/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Save narrower access<\/button>/);
    assert.match(html, /<button class="button secondary danger-text">Revoke<\/button>/);
    assert.doesNotMatch(html, /access is revoked|Reauthorization required|selected actions|type="checkbox"/);
  });
}

test("v2 declarations remain supported", () => {
  assert.equal(hasSupportedCapabilityDeclaration({
    contracts: [], capabilities: { contract_version: 2, required: ["collection.read"] }
  }), true);
});
