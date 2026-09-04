import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationCapabilityGroups,
  selectedFileActions,
  selectedOperationsForCapabilityGroups
} from "./src/authorization-capabilities.ts";

const requirements = {
  contracts: [],
  capabilities: {
    contract_version: 2,
    required: ["collection.read"],
    optional: ["records.edit", "records.delete"]
  }
};

const read = [
  "describe", "changes", "read", "query", "list_views", "execute_view",
  "read_view_source", "validate", "read_type"
];

test("exposes only requested optional capability groups", () => {
  const groups = authorizationCapabilityGroups(
    requirements,
    [...read, "update", "rename"]
  );
  assert.deepEqual(groups.map(({ id, required }) => ({ id, required })), [
    { id: "collection.read", required: true },
    { id: "records.edit", required: false }
  ]);
});

test("restores optional capabilities only as complete groups", () => {
  const groups = authorizationCapabilityGroups(
    requirements,
    [...read, "update", "rename", "delete"]
  );
  assert.deepEqual(
    [...selectedOperationsForCapabilityGroups(groups, ["update"])],
    read
  );
  assert.deepEqual(
    [...selectedOperationsForCapabilityGroups(groups, ["update", "rename"])],
    [...read, "update", "rename"]
  );
});

test("required file actions survive restoration while optional actions remain selectable", () => {
  const files = {
    required: ["list", "read"],
    optional: ["add", "delete"],
    scope: { kind: "collection" }
  };
  assert.deepEqual([...selectedFileActions(files, ["delete", "replace"])], [
    "list", "read", "delete"
  ]);
  assert.deepEqual([...selectedFileActions(files)], [
    "list", "read", "add", "delete"
  ]);
});
