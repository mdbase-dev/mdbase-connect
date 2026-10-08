import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationCapabilityGroups,
  selectedFileActions,
  selectedOperationsForCapabilityGroups,
  selectedPeoplePermissions,
  nextAuthorizationGroups,
  selectedNextAuthorizationOperations,
  toggleAuthorizationGroup
} from "./src/authorization-capabilities.ts";

const requirements = {
  contracts: [],
  capabilities: {
    contract_version: 2,
    required: ["collection.read"],
    optional: ["records.edit", "records.delete"]
  }
};

const jointRequirements = {
  ...requirements,
  files: { required: ["list", "read"], optional: ["replace", "move", "delete"], scope: { kind: "collection" } }
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
    "list", "read", "add"
  ]);
});

test("optional higher-impact capabilities start denied without a saved review", () => {
  const groups = authorizationCapabilityGroups(
    requirements,
    [...read, "update", "rename", "delete"]
  );
  assert.deepEqual(
    [...selectedOperationsForCapabilityGroups(groups)],
    [...read, "update", "rename"]
  );
  assert.deepEqual(
    [...selectedOperationsForCapabilityGroups(groups, [...read, "delete"])],
    [...read, "delete"]
  );
});

test("next capabilities display and select record/file rights jointly without adding undeclared actions", () => {
  const { groups, error } = nextAuthorizationGroups(jointRequirements, [...read, "update", "rename", "delete"]);
  assert.equal(error, undefined);
  assert.deepEqual(groups.map(group => group.fileActions), [["list", "read"], ["replace", "move"], ["delete"]]);
  assert.deepEqual([...selectedNextAuthorizationOperations(groups)], [...read, "update", "rename"]);
  assert.deepEqual([...toggleAuthorizationGroup(new Set(read), groups[1])], [...read, "update", "rename"]);
  assert.match(groups[0].description, /list file names and read file contents/);
  assert.match(groups[1].description, /replace, move, and rename/);
});

test("next refuses missing paired declarations, required files without record rights and v1", () => {
  for (const input of [requirements,
    { ...jointRequirements, files: { ...jointRequirements.files, required: ["read"] } },
    { contracts: [], capabilities: { contract_version: 2, required: ["views.manage"] }, files: { required: ["delete"], scope: { kind: "collection" } } },
    { contracts: [] }]) {
    const result = nextAuthorizationGroups(input, [...read, "update", "rename", "delete"]);
    assert.match(result.error, /must update its permissions/);
    assert.deepEqual(result.groups, []);
  }
});

test("next does not restore an optional capability from a partial record or file review", () => {
  const { groups } = nextAuthorizationGroups(jointRequirements, [...read, "update", "rename", "delete"]);
  for (const [ops, files] of [
    [[...read, "update", "rename"], ["list", "read", "replace"]],
    [[...read, "update"], ["list", "read", "replace", "move"]],
    [[...read, "update", "rename"], undefined]
  ]) assert.deepEqual([...selectedNextAuthorizationOperations(groups, ops, files)], read);
  assert.deepEqual([...selectedNextAuthorizationOperations(groups, [...read, "delete"], ["list", "read", "delete"])], [...read, "delete"]);
});

test("next locks both halves when an app requires a paired file action", () => {
  const input = { ...jointRequirements, files: { ...jointRequirements.files, required: ["list", "read", "replace"], optional: ["move", "delete"] } };
  const { groups } = nextAuthorizationGroups(input, [...read, "update", "rename", "delete"]);
  assert.equal(groups[1].required, true);
  assert.deepEqual([...selectedNextAuthorizationOperations(groups, [], [])], [...read, "update", "rename"]);
  assert.deepEqual([...toggleAuthorizationGroup(new Set([...read, "update", "rename"]), groups[1])], [...read, "update", "rename"]);
});

test("people permissions keep required ones and start higher-impact optional ones denied", () => {
  assert.deepEqual([...selectedPeoplePermissions({ version: 1, required: ["identity"], optional: ["members"] })], ["identity"]);
  assert.deepEqual([...selectedPeoplePermissions({ version: 1, optional: ["identity", "members"] })], ["identity"]);
  assert.deepEqual(
    [...selectedPeoplePermissions({ version: 1, optional: ["identity", "members"] }, ["members", "unknown"])],
    ["members"]
  );
  assert.deepEqual([...selectedPeoplePermissions({ version: 1, required: ["members"] }, [])], ["members"]);
});
