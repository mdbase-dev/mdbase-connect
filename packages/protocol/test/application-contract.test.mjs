import test from "node:test";
import assert from "node:assert/strict";
import {
  semanticContractVersion, authorizationOperations, authorizationFiles,
  authorizationContractRequirements, MdbaseConnectError
} from "../dist/index.js";

const bare = () => ({ access: "full_collection", contracts: [] });

function invalid(run, message) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof MdbaseConnectError);
    assert.equal(error.name, "MdbaseConnectError");
    assert.equal(error.code, "invalid_application_manifest");
    assert.equal(error.message, message);
    assert.deepEqual(error.problem, {
      problem_version: 1, code: "invalid_application_manifest",
      category: "validation", recovery: "fix_request", message,
      details: { issues: [{ path: "/requirements/capabilities", keyword: "authorizationSelection", message, params: {} }] }
    });
    return true;
  });
}

test("bare normalized full_collection retains exact v1 readonly defaults without files or mutation authority", () => {
  const requirements = bare();
  const operations = authorizationOperations({ requirements }, {});
  const files = authorizationFiles(requirements);
  assert.equal(semanticContractVersion(requirements), 1);
  assert.deepEqual(operations, ["describe", "changes", "read", "query"]);
  assert.equal(files, undefined);
  assert.deepEqual(authorizationContractRequirements(operations, files, [], semanticContractVersion(requirements)), {
    operation_transport: 3, authorization_binding: 5, semantic_capabilities: 1
  });
  operations.push("create");
  assert.deepEqual(authorizationOperations({ requirements }, {}), ["describe", "changes", "read", "query"]);
  assert.deepEqual(requirements, bare());
});

test("v1 explicit selections and exact file actions retain the predecessor instead of translating to v2", () => {
  const requirements = {
    ...bare(), capabilities: { contract_version: 1, required: ["records.read"], optional: ["records.update"] },
    files: { actions: ["read", "replace"], scope: { kind: "collection" } }
  };
  assert.deepEqual(authorizationOperations({ requirements }, {}), ["describe", "changes", "read", "query"]);
  assert.deepEqual(authorizationOperations({ requirements }, { capabilities: ["records.update"] }), ["read", "update"]);
  assert.deepEqual(authorizationOperations({ requirements }, { operations: ["read", "read"] }), ["read"]);
  const files = authorizationFiles(requirements);
  assert.deepEqual(files, { actions: ["read", "replace"], scope: { kind: "collection" } });
  files.actions.push("delete"); files.scope.kind = "none";
  assert.deepEqual(requirements.files, { actions: ["read", "replace"], scope: { kind: "collection" } });
});

test("v2 preserves required groups, selected optionals, setup intent and independent file lowering", () => {
  const requirements = {
    ...bare(), capabilities: { contract_version: 2, required: ["records.create"], optional: ["records.edit"] },
    files: { required: ["read"], optional: ["replace", "read"], scope: { kind: "collection" } }
  };
  assert.equal(semanticContractVersion(requirements), 2);
  assert.deepEqual(authorizationOperations({ requirements }, {}), ["create", "update", "rename"]);
  assert.deepEqual(authorizationOperations({ requirements }, { capabilities: [] }), ["create"]);
  assert.deepEqual(authorizationOperations({ requirements, provisions: { type_packs: [{}] } }, { capabilities: [] }), [
    "create", "assess_collection_setup", "apply_collection_setup"
  ]);
  assert.deepEqual(authorizationFiles(requirements), { actions: ["read", "replace"], scope: { kind: "collection" } });
  assert.deepEqual(authorizationContractRequirements(["create"], authorizationFiles(requirements), [], 2), {
    operation_transport: 3, authorization_binding: 5, semantic_capabilities: 2, durable_mutation: 1
  });
});

test("unchanged closed selection/version/file errors retain the same public problem carrier", () => {
  invalid(() => semanticContractVersion({ ...bare(), capabilities: { contract_version: 99, required: [] } }),
    "Unsupported declared capability contract version.");
  invalid(() => authorizationOperations({ requirements: bare() }, { operations: ["read"], capabilities: [] }),
    "Specify operations or capabilities, not both.");
  invalid(() => authorizationOperations({ requirements: { ...bare(), capabilities: { contract_version: 2, required: [] } } }, { operations: ["read"] }),
    "Exact operations authorization is only supported for legacy v1 declarations.");
  invalid(() => authorizationOperations({ requirements: bare() }, { capabilities: ["records.create"] }),
    "Authorization can only include capabilities declared by the application.");
  invalid(() => authorizationFiles({ ...bare(), files: { required: ["read"], scope: { kind: "collection" } } }),
    "Legacy file declarations must use exact files.actions.");
  invalid(() => authorizationFiles({ ...bare(), capabilities: { contract_version: 2, required: [] }, files: { actions: ["read"], scope: { kind: "collection" } } }),
    "V2 file declarations must use required/optional file actions.");
});
