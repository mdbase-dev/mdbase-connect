import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  authorizationCapabilityGroups, authorizationRequirementsError,
  selectedOperationsForCapabilityGroups, selectedFileActions, toggleAuthorizationGroup
} from "./src/authorization-capabilities.ts";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
const ui = await server.ssrLoadModule("/src/authorization-review.tsx");
const { ApprovalForm } = await server.ssrLoadModule("/src/authorization-view.tsx");
await server.close();
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

const list = (props) => render(ui.PermissionList, {
  selectedFiles: new Set(), disabled: false, onToggleGroup() {}, onToggleFile() {}, ...props
});
const checkboxes = (html) => (html.match(/type="checkbox"/g) ?? []).length;
const checked = (html) => (html.match(/type="checkbox" checked=""/g) ?? []).length;

for (const version of [undefined, 1]) {
  test(`v1 (${version ?? "absent"}) renders and selects only exact requested operations`, () => {
    const requirements = { contracts: [], ...(version ? { capabilities: { contract_version: version, required: ["records.update"] } } : {}) };
    for (const [operation, label] of [["read", "Read records"], ["update", "Change records"], ["put_timer", "Create or update timers"]]) {
      const groups = authorizationCapabilityGroups(requirements, [operation]);
      assert.deepEqual(groups.flatMap(g => g.operations), [operation]);
      const selected = selectedOperationsForCapabilityGroups(groups);
      const html = list({ groups, selected });
      assert.match(html, new RegExp(label));
      assert.doesNotMatch(html, /Rename|Search and query|records.edit|Allow the/);
      assert.equal(checkboxes(html), 1);
      assert.equal(checked(html), 1);
      assert.deepEqual([...toggleAuthorizationGroup(selected, groups[0])], []);
      assert.deepEqual([...toggleAuthorizationGroup(new Set(), groups[0])], [operation]);
    }
  });
}

test("v1 partial saved operation selection is not rounded or expanded", () => {
  const groups = authorizationCapabilityGroups({ contracts: [] }, ["read", "update", "rename", "put_timer"]);
  const selected = selectedOperationsForCapabilityGroups(groups, ["update", "put_timer", "query"]);
  assert.deepEqual([...selected], ["update", "put_timer"]);
  const html = list({ groups, selected });
  assert.equal(checkboxes(html), 4);
  assert.equal(checked(html), 2);
  assert.equal(selectedOperationsForCapabilityGroups(groups, []).size, 0);
});

test("v1 exact operations start selected because required and optional are indistinguishable", () => {
  const groups = authorizationCapabilityGroups({ contracts: [] }, ["read", "delete", "apply_type_pack"]);
  assert.deepEqual([...selectedOperationsForCapabilityGroups(groups)], ["read", "delete", "apply_type_pack"]);
  assert.equal((list({ groups, selected: new Set(["read"]) }).match(/Higher impact/g) ?? []).length, 2);
});

test("v1 files.actions remain fixed exact approval, regardless of saved file actions", () => {
  const files = { actions: ["read", "replace"], scope: { kind: "collection" } };
  assert.deepEqual([...selectedFileActions(files, ["delete"])], ["read", "replace"]);
  const html = list({ groups: [], files, selectedFiles: selectedFileActions(files), onToggleFile() { assert.fail(); } });
  assert.match(html, /Read file contents/);
  assert.match(html, /Replace existing files/);
  assert.match(html, /approved together/);
  assert.doesNotMatch(html, /checkbox|Delete files|Required/);
});

test("v2 required groups are fixed; optional groups atomic; optional files independent", () => {
  const requirements = { contracts: [], capabilities: { contract_version: 2, required: ["records.create"], optional: ["records.edit"] } };
  const groups = authorizationCapabilityGroups(requirements, ["create", "update", "rename"]);
  let selected = selectedOperationsForCapabilityGroups(groups, ["update"]);
  assert.deepEqual([...selected], ["create"]);
  selected = toggleAuthorizationGroup(selected, groups[0]);
  assert.deepEqual([...selected], ["create"]);
  selected = toggleAuthorizationGroup(selected, groups[1]);
  assert.deepEqual([...selected], ["create", "update", "rename"]);
  const html = list({ groups, selected });
  assert.equal(checkboxes(html), 1, "the required group has no toggle");
  assert.equal((html.match(/>Required</g) ?? []).length, 1);
  const files = { required: ["read"], optional: ["add", "delete"], scope: { kind: "folders", folders: ["attachments"] } };
  const selectedFiles = selectedFileActions(files, ["delete"]);
  assert.deepEqual([...selectedFiles], ["read", "delete"]);
  const fileHtml = list({ groups: [], files, selectedFiles });
  assert.equal(checkboxes(fileHtml), 2, "only optional file actions are toggles");
  assert.equal(checked(fileHtml), 1);
  assert.match(fileHtml, /Only attachments\. Hidden folders are always excluded\./);
  assert.equal((fileHtml.match(/Higher impact/g) ?? []).length, 1);
});

test("reauthorization marks only permissions the application does not already have", () => {
  const requirements = { contracts: [], capabilities: { contract_version: 2, required: ["collection.read"], optional: ["records.create"] } };
  const read = ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type"];
  const groups = authorizationCapabilityGroups(requirements, [...read, "create"]);
  const selected = selectedOperationsForCapabilityGroups(groups);
  assert.equal((list({ groups, selected, existingOperations: new Set(read) }).match(/>New</g) ?? []).length, 1);
  assert.doesNotMatch(list({ groups, selected, existingOperations: new Set() }), />New</);
});

test("the pre-choice summary names requested access without controls", () => {
  const requirements = { contracts: [], capabilities: { contract_version: 2, required: ["collection.read"], optional: ["records.delete"] } };
  const groups = authorizationCapabilityGroups(requirements, ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type", "delete"]);
  const html = render(ui.RequestedAccessSummary, { groups, files: { required: ["read"], optional: ["delete"], scope: { kind: "collection" } } });
  assert.match(html, /Read this collection/);
  assert.match(html, /Delete records/);
  assert.match(html, /Manage and delete files/);
  assert.doesNotMatch(html, /checkbox/);
});

for (const requirements of [
  { capabilities: { contract_version: 99, required: [] } },
  { capabilities: { contract_version: 2, required: ["records.update"] } },
  { capabilities: { contract_version: 1, required: ["records.edit"] } },
  { capabilities: { contract_version: 2, required: [] }, files: { actions: ["read"] } },
  { files: { required: ["read"] } },
  { capabilities: { required: [] } }
]) test(`unsupported/mixed request fails visibly closed: ${JSON.stringify(requirements)}`, () => {
  assert.ok(authorizationRequirementsError(requirements));
  assert.deepEqual(authorizationCapabilityGroups(requirements, ["update"]), []);
  const html = render(ApprovalForm, { request: { requirements } });
  assert.match(html, /role="alert"/);
  assert.match(html, /Access cannot be approved/);
  assert.doesNotMatch(html, /button|checkbox/);
});
