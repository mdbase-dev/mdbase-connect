import assert from "node:assert/strict";
import test from "node:test";
import { APPLICATION_CAPABILITY_DEFINITIONS } from "../dist/index.js";
import { exactNextPermissionCapabilities, projectNextAuthorizationGroups } from "../dist/next-authorization.js";

const read = [...APPLICATION_CAPABILITY_DEFINITIONS["collection.read"]];
const readCaps = ["collection.inspect", "records.watch", "records.read", "records.query", "views.list", "views.execute", "views.source.read", "records.validate", "definitions.read"];
const legacy = {
  contracts: [], access: "full_collection",
  capabilities: { contract_version: 1, required: [...readCaps, "files.list", "files.read", "files.add"], optional: ["records.create", "records.update", "records.rename", "records.delete", "sync.offline-replica"] },
  files: { actions: ["list", "read", "add"], scope: { kind: "selected_folders", folders: ["attachments"] } }
};
const requested = [...read, "create", "update", "rename", "delete", "sync"];

test("fresh v1 offers an exact consistent subset, preserving fixed files and original declaration", () => {
  const original = structuredClone(legacy);
  const result = projectNextAuthorizationGroups(legacy, requested);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.groups.map(({ id, required }) => ({ id, required })), [
    { id: "collection.read", required: true }, { id: "records.create", required: true }
  ]);
  assert.deepEqual(result.groups.flatMap(group => group.operations), [...read, "create"]);
  assert.deepEqual(result.groups.flatMap(group => group.fileActions), ["list", "read", "add"]);
  assert.deepEqual(exactNextPermissionCapabilities([...read, "create"], legacy.files.actions), ["collection.read", "records.create"]);
  assert.deepEqual(legacy, original);
  for (const required of ["records.update", "records.delete", "sync.offline-replica"]) {
    assert.ok(projectNextAuthorizationGroups({ ...legacy, capabilities: { ...legacy.capabilities, required: [...readCaps, required], optional: legacy.capabilities.optional.filter(id => id !== required) } }, requested).error);
  }
  assert.ok(projectNextAuthorizationGroups({ ...legacy, files: { ...legacy.files, actions: ["list", "read", "replace"] } }, requested).error);
});

test("v1 partial required groups and mixed/unknown declarations remain refused", () => {
  for (const input of [
    { ...legacy, capabilities: { contract_version: 1, required: ["records.read"] } },
    { ...legacy, capabilities: undefined },
    { ...legacy, access: "contract" },
    { ...legacy, files: { required: ["list", "read"] } },
    { ...legacy, capabilities: { contract_version: 99, required: [] } },
    { ...legacy, capabilities: { contract_version: 1, required: ["records.edit"] } }
  ]) {
    const result = projectNextAuthorizationGroups(input, ["read"]);
    assert.deepEqual(result.groups, []);
    assert.equal(result.error, "This app needs an update before it can connect. Try again after it updates.");
  }
  assert.equal(exactNextPermissionCapabilities(["read"], ["read"]), undefined);
  assert.equal(exactNextPermissionCapabilities(read, ["list"]), undefined);
});

test("v1 setup is representable only alongside its complete declared definition group", () => {
  const definitions = [...APPLICATION_CAPABILITY_DEFINITIONS["definitions.manage"]];
  const setup = ["assess_collection_setup", "apply_collection_setup"];
  const input = { ...legacy, files: { ...legacy.files, actions: ["list", "read"] }, capabilities: { contract_version: 1, required: [...readCaps, "files.list", "files.read", "definitions.create", "definitions.update", "definitions.type-pack.apply", "collection.setup.apply"] } };
  const result = projectNextAuthorizationGroups(input, [...read, ...definitions, ...setup]);
  assert.equal(result.error, undefined);
  assert.deepEqual(exactNextPermissionCapabilities(result.groups.flatMap(group => group.operations), ["list", "read"]), ["collection.read", "definitions.manage"]);
  assert.ok(projectNextAuthorizationGroups(input, [...read, ...definitions, setup[0]]).error);
  assert.ok(projectNextAuthorizationGroups({ ...input, capabilities: { ...input.capabilities, optional: ["definitions.create"] } }, [...read, ...definitions, ...setup]).error);
  assert.ok(projectNextAuthorizationGroups({ ...input, files: { ...input.files, actions: ["list", "read", "read"] } }, [...read, ...definitions, ...setup]).error);
});

test("v2 keeps optional pairs optional and cannot synthesize their missing file rights", () => {
  const requirements = { contracts: [], capabilities: { contract_version: 2, required: ["collection.read"], optional: ["records.create", "records.edit", "records.delete"] }, files: { required: ["list", "read"], optional: ["add"], scope: { kind: "collection" } } };
  const result = projectNextAuthorizationGroups(requirements, requested);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.groups.map(({ id, required }) => ({ id, required })), [
    { id: "collection.read", required: true }, { id: "records.create", required: false }
  ]);
  assert.ok(projectNextAuthorizationGroups({ ...requirements, files: legacy.files }, requested).error);
});
