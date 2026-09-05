import assert from "node:assert/strict";
import test from "node:test";
import { requestCapabilityGroups } from "../src/renderer/application-capabilities.ts";

const read = [
  "describe", "changes", "read", "query", "list_views", "execute_view",
  "read_view_source", "validate", "read_type"
];

test("grant editing exposes only complete application capability groups", () => {
  const groups = requestCapabilityGroups({
    contracts: [],
    capabilities: {
      contract_version: 2,
      required: ["collection.read"],
      optional: ["records.edit", "records.delete"]
    }
  }, [...read, "update", "rename"]);
  assert.deepEqual(groups.map(({ id, required }) => ({ id, required })), [
    { id: "collection.read", required: true },
    { id: "records.edit", required: false }
  ]);
});

test("partial operation lists are never presented as a capability", () => {
  const groups = requestCapabilityGroups({
    contracts: [],
    capabilities: {
      contract_version: 2,
      required: ["collection.read"],
      optional: ["records.edit"]
    }
  }, [...read, "update"]);
  assert.deepEqual(groups.map(({ id }) => id), ["collection.read"]);
});
