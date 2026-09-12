import { describe, expect, it } from "vitest";
import type { CollectionOperation } from "@mdbase-dev/connect-protocol";
import { operationsForApplicationCapabilities } from "@mdbase-dev/connect-protocol";
import {
  ownerAccess,
  type CollectionAccessContext
} from "./collection-access.js";
import { planCollectionGrant, previewCollectionGrant } from "./grant-planner.js";

const owner = ownerAccess({
  collectionId: "collection",
  authorityKind: "hosted",
  authorityRowId: "collection",
  ownerUserId: "owner",
  authorityEpoch: 3,
  authorityState: "active",
  displayName: "Tasks"
}, "owner");

describe("previewCollectionGrant", () => {
  const capabilities = {
    contract_version: 2 as const,
    required: ["collection.read"] as const,
    optional: ["records.edit", "records.delete", "definitions.manage"] as const
  };
  const readOperations = operationsForApplicationCapabilities({
    contract_version: 2, required: ["collection.read"]
  });
  const viewer: CollectionAccessContext = {
    ...owner,
    relationship: "member",
    role: "viewer",
    operationCeiling: new Set(readOperations),
    fileCeiling: { ...owner.fileCeiling, actions: ["list", "read"] }
  };
  const input = {
    applicationOperationCeiling: operationsForApplicationCapabilities(capabilities),
    requirements: {
      contracts: [], access: "full_collection" as const, capabilities,
      files: { required: ["list", "read"] as const, optional: ["add"] as const, scope: { kind: "collection" as const } }
    },
    access: viewer
  };

  it("offers a viewer only complete read capabilities and required file reads", () => {
    const preview = previewCollectionGrant(input);
    expect(preview).toEqual({ available: true, operations: readOperations, file_actions: ["list", "read"] });
    if (!preview.available) throw new Error("Expected a viewer offer");
    expect(planCollectionGrant({ ...input, requestedOperations: preview.operations, requestedFileActions: preview.file_actions }).replicaMode).toBe("read_only");
  });

  it("omits an optional group when a stored policy permits only part of it", () => {
    const preview = previewCollectionGrant({ ...input, access: { ...viewer, operationCeiling: new Set([...readOperations, "update"]) } });
    expect(preview).toEqual({ available: true, operations: readOperations, file_actions: ["list", "read"] });
  });

  it("marks required writes and required file writes unavailable to a viewer", () => {
    for (const requirements of [
      { ...input.requirements, capabilities: { contract_version: 2 as const, required: ["collection.read", "records.edit"] as const } },
      { ...input.requirements, files: { ...input.requirements.files, required: ["list", "read", "add"] as const, optional: [] } }
    ]) expect(previewCollectionGrant({ ...input, requirements }).available).toBe(false);
    expect(previewCollectionGrant({ ...input, access: owner }).available).toBe(true);
  });
});

describe("planCollectionGrant", () => {
  it("plans every operation compiled for type-pack application sessions", () => {
    const capabilities = {
      contract_version: 2 as const,
      required: ["definitions.manage"] as const
    };
    const operations = operationsForApplicationCapabilities(capabilities);
    const result = planCollectionGrant({
      requestedOperations: operations,
      applicationOperationCeiling: operations,
      requirements: {
        contracts: [],
        access: "full_collection",
        capabilities
      },
      access: owner
    });

    expect(result).toEqual({
      operations: ["create_type", "update_type", "assess_type_pack", "apply_type_pack"],
      scope: { access: "full_collection", contracts: [] },
      replicaMode: "read_write"
    });
  });

  it("uses collection authority while retaining contracts as compatibility requirements", () => {
    const capabilities = {
      contract_version: 2 as const,
      required: ["collection.read", "records.edit"] as const
    };
    const operations = operationsForApplicationCapabilities(capabilities);
    const result = planCollectionGrant({
      requestedOperations: operations,
      applicationOperationCeiling: operations,
      requirements: {
        access: "full_collection",
        capabilities,
        contracts: [{
          id: "example.tasks",
          version: "1.0.0",
          digest: `sha256:${"a".repeat(64)}`
        }]
      },
      access: owner
    });

    expect(result).toEqual({
      operations,
      scope: { access: "full_collection", contracts: [] },
      replicaMode: "read_write"
    });
  });

  it("plans file-only access independently from collection record authority", () => {
    const result = planCollectionGrant({
      requestedOperations: [],
      applicationOperationCeiling: [],
      requirements: {
        access: "full_collection",
        contracts: [],
        capabilities: { contract_version: 2, required: [] },
        files: {
          required: ["list", "read"],
          optional: ["add"],
          scope: { kind: "selected_folders", folders: ["Assets"] }
        }
      },
      access: owner
    });

    expect(result).toEqual({
      operations: [],
      scope: { access: "full_collection", contracts: [] },
      replicaMode: "read_write",
      fileCapability: {
        kind: "files",
        protocol_version: 1,
        actions: ["list", "read", "add"],
        scope: { kind: "selected_folders", folders: ["Assets"] }
      }
    });
  });

  it("allows optional file actions to be denied without dropping required actions", () => {
    const requirements = {
      access: "full_collection" as const,
      contracts: [],
      capabilities: { contract_version: 2 as const, required: [] },
      files: {
        required: ["list", "read"] as const,
        optional: ["add", "delete"] as const,
        scope: { kind: "collection" as const }
      }
    };
    const result = planCollectionGrant({
      requestedOperations: [],
      applicationOperationCeiling: [],
      requestedFileActions: ["list", "read", "add"],
      requirements,
      access: owner
    });
    expect(result.fileCapability?.actions).toEqual(["list", "read", "add"]);
    expect(() => planCollectionGrant({
      requestedOperations: [],
      applicationOperationCeiling: [],
      requestedFileActions: ["list", "delete"],
      requirements,
      access: owner
    })).toThrow("Required file actions");
  });

  it("rejects partial optional capability groups", () => {
    const capabilities = {
      contract_version: 2 as const,
      required: ["collection.read"] as const,
      optional: ["records.edit"] as const
    };
    const required = operationsForApplicationCapabilities(
      capabilities,
      { includeOptional: false }
    );
    expect(() => planCollectionGrant({
      requestedOperations: [...required, "update"],
      applicationOperationCeiling: [...required, "update", "rename"],
      requirements: {
        access: "full_collection",
        contracts: [],
        capabilities
      },
      access: owner
    })).toThrow("complete groups");
  });

  it("rejects legacy contract-scoped authorization instead of widening it", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["read"],
      applicationOperationCeiling: ["read"],
      requirements: { contracts: [], access: "contract" },
      access: owner
    })).toThrow("not widened");
  });

  it("rejects omitted access instead of defaulting to collection authority", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["read"],
      applicationOperationCeiling: ["read"],
      requirements: { contracts: [] },
      access: owner
    })).toThrow("not widened");
  });

  it("rejects an operation the application did not request", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["delete"],
      applicationOperationCeiling: ["read"],
      requirements: { contracts: [], access: "full_collection" },
      access: owner
    })).toThrow("must be requested");
  });

  it("rejects an operation outside the approving user's ceiling", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["update"],
      applicationOperationCeiling: ["update"],
      requirements: { contracts: [], access: "full_collection" },
      access: restricted(owner, ["read"])
    })).toThrow("approving user");
  });
});

function restricted(
  source: CollectionAccessContext,
  operations: CollectionOperation[]
): CollectionAccessContext {
  return {
    ...source,
    relationship: "member",
    operationCeiling: new Set(operations)
  };
}

describe("membership ceilings with v2 capabilities", () => {
  const read = operationsForApplicationCapabilities({ contract_version: 2, required: ["collection.read"] });
  const viewer: CollectionAccessContext = {
    ...owner, relationship: "member", role: "viewer", operationCeiling: new Set([...read, "sync"]),
    fileCeiling: { kind: "files", protocol_version: 1, actions: ["list", "read"], scope: { kind: "collection" } }
  };
  const requirements = {
    access: "full_collection" as const, contracts: [],
    capabilities: { contract_version: 2 as const, required: ["collection.read"] as const, optional: ["records.edit"] as const },
    files: { required: ["list", "read"] as const, optional: ["add"] as const, scope: { kind: "collection" as const } }
  };
  const input = { requirements, access: viewer, requestedOperations: read,
    applicationOperationCeiling: operationsForApplicationCapabilities(requirements.capabilities) };

  it("permits read-only approval after complete optional write groups and file actions are denied", () => {
    expect(planCollectionGrant({ ...input, requestedFileActions: ["list", "read"] }))
      .toMatchObject({ replicaMode: "read_only", operations: read, fileCapability: { actions: ["list", "read"] } });
  });
  it("checks selected optional file writes against membership authority", () => {
    expect(() => planCollectionGrant(input)).toThrow("file actions");
    expect(() => planCollectionGrant({ ...input, requestedFileActions: ["list", "read", "add"] })).toThrow("file actions");
  });
  it("rejects required writes instead of silently dropping them", () => {
    expect(() => planCollectionGrant({ ...input, requirements: { ...requirements,
      files: { required: ["list", "read", "add"], scope: { kind: "collection" } } } })).toThrow("file actions");
    expect(() => planCollectionGrant({ ...input, requestedFileActions: ["list", "read"], requirements: { ...requirements,
      capabilities: { contract_version: 2, required: ["collection.read", "records.edit"] } } })).toThrow("complete groups");
  });
  it("does not widen a member's file or collection scope", () => {
    expect(() => planCollectionGrant({ ...input, requestedFileActions: ["list", "read"], access: {
      ...viewer, fileCeiling: { ...viewer.fileCeiling, scope: { kind: "selected_folders", folders: ["Assets"] } }
    } })).toThrow("collection-wide file access");
    expect(() => planCollectionGrant({ ...input, requestedFileActions: ["list", "read"], access: {
      ...viewer, scopeCeiling: { access: "contract", contracts: [] }
    } })).toThrow("full-collection access");
  });
});
