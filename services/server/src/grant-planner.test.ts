import { describe, expect, it } from "vitest";
import type { CollectionOperation } from "@mdbase-dev/connect-protocol";
import { operationsForApplicationCapabilities } from "@mdbase-dev/connect-protocol";
import {
  ownerAccess,
  type CollectionAccessContext
} from "./collection-access.js";
import { planCollectionGrant } from "./grant-planner.js";

const owner = ownerAccess({
  collectionId: "collection",
  authorityKind: "hosted",
  authorityRowId: "collection",
  ownerUserId: "owner",
  authorityEpoch: 3,
  authorityState: "active",
  displayName: "Tasks"
}, "owner");

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
    const result = planCollectionGrant({
      requestedOperations: ["read", "update"],
      applicationOperationCeiling: ["read", "query", "update"],
      requirements: {
        access: "full_collection",
        contracts: [{
          id: "example.tasks",
          version: "1.0.0",
          digest: `sha256:${"a".repeat(64)}`
        }]
      },
      access: owner
    });

    expect(result).toEqual({
      operations: ["read", "update"],
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
