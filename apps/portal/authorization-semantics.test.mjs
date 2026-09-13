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
const ui = await server.ssrLoadModule("/src/authorization-permissions.tsx");
const { ApprovalForm } = await server.ssrLoadModule("/src/authorization-view.tsx");
await server.close();
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

for (const version of [undefined, 1]) {
  test(`v1 (${version ?? "absent"}) renders and selects only exact requested operations`, () => {
    const requirements = { contracts: [], ...(version ? { capabilities: { contract_version: version, required: ["records.update"] } } : {}) };
    for (const [operation, label] of [["read", "Read records"], ["update", "Change records"], ["put_timer", "Create or update timers"]]) {
      const groups = authorizationCapabilityGroups(requirements, [operation]);
      assert.deepEqual(groups.flatMap(g => g.operations), [operation]);
      const selected = selectedOperationsForCapabilityGroups(groups);
      const html = render(ui.PermissionChoices, { groups, selected, disabled: false, onToggle() {} });
      assert.match(html, new RegExp(label));
      assert.doesNotMatch(html, /Rename|Search and query|records.edit|complete group/);
      assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
      assert.deepEqual([...toggleAuthorizationGroup(selected, groups[0])], []);
      assert.deepEqual([...toggleAuthorizationGroup(new Set(), groups[0])], [operation]);
    }
  });
}

test("v1 partial saved operation selection is not rounded or expanded", () => {
  const groups = authorizationCapabilityGroups({ contracts: [] }, ["read", "update", "rename", "put_timer"]);
  const selected = selectedOperationsForCapabilityGroups(groups, ["update", "put_timer", "query"]);
  assert.deepEqual([...selected], ["update", "put_timer"]);
  const html = render(ui.PermissionCapabilitySummary, { groups, selected, selectedFiles: new Set() });
  assert.match(html, /Change records/);
  assert.doesNotMatch(html, /Rename|Read records|Search/);
  assert.equal(selectedOperationsForCapabilityGroups(groups, []).size, 0);
});

test("v1 files.actions remain fixed exact approval, regardless of saved file actions", () => {
  const files = { actions: ["read", "replace"], scope: { kind: "collection" } };
  assert.deepEqual([...selectedFileActions(files, ["delete"])], ["read", "replace"]);
  const html = render(ui.FilePermissionSummary, { files, selected: selectedFileActions(files), disabled: false, onToggle() { assert.fail(); } });
  assert.match(html, /Read file contents/);
  assert.match(html, /Replace existing files/);
  assert.doesNotMatch(html, /checkbox|Delete files|optional|\(required\)/);
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
  const html = render(ui.PermissionChoices, { groups, selected, disabled: false, onToggle() {} });
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
  assert.match(html, /complete group/);
  const files = { required: ["read"], optional: ["add", "delete"], scope: { kind: "collection" } };
  const selectedFiles = selectedFileActions(files, ["delete"]);
  assert.deepEqual([...selectedFiles], ["read", "delete"]);
  const fileHtml = render(ui.FilePermissionSummary, { files, selected: selectedFiles, disabled: false, onToggle() {} });
  assert.equal((fileHtml.match(/type="checkbox"/g) ?? []).length, 3);
  assert.match(fileHtml, /disabled/);
  const inputs = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node.type === "input") inputs.push(node.props);
    visit(node.props?.children);
  }
  visit(ui.FilePermissionSummary({ files, selected: selectedFiles, disabled: false, onToggle(action) {
    if (selectedFiles.has(action)) selectedFiles.delete(action);
    else selectedFiles.add(action);
  } }));
  assert.equal(inputs[0].disabled, true);
  assert.equal(inputs[0].onChange, undefined);
  inputs[1].onChange();
  assert.deepEqual([...selectedFiles], ["read", "delete", "add"]);
  inputs[2].onChange();
  assert.deepEqual([...selectedFiles], ["read", "add"]);
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
