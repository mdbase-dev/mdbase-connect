import { describe, expect, it } from "vitest";
import type {
  CollectionContractDescriptor,
  CollectionOperation,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import { operationsForApplicationCapabilities } from "@mdbase-dev/connect-protocol";
import {
  ownerAccess,
  type CollectionAccessContext
} from "./collection-access.js";
import { planCollectionGrant } from "./grant-planner.js";

const contract: CollectionContractDescriptor = {
  id: "example.tasks",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  schema: {},
  implementations: []
};

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
      contract_version: 1 as const,
      required: ["definitions.type-pack.apply"] as const
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
      availableContracts: [],
      access: owner
    });

    expect(result).toEqual({
      operations: ["assess_type_pack", "apply_type_pack"],
      scope: { access: "full_collection", contracts: [] },
      replicaMode: "read_write"
    });
  });

  it("intersects application, request, and human access ceilings", () => {
    const result = planCollectionGrant({
      requestedOperations: ["read", "update"],
      applicationOperationCeiling: ["read", "query", "update"],
      requirements: {
        contracts: [{ id: contract.id, version: contract.version, digest: contract.digest }]
      },
      availableContracts: [contract],
      access: owner
    });

    expect(result).toEqual({
      operations: ["read", "update"],
      scope: { access: "contract", contracts: [contract] },
      replicaMode: "read_write"
    });
  });

  it("plans file-only access independently from record scope", () => {
    const result = planCollectionGrant({
      requestedOperations: [],
      applicationOperationCeiling: [],
      requirements: {
        contracts: [],
        files: {
          actions: ["list", "read", "add"],
          scope: { kind: "selected_folders", folders: ["Assets"] }
        }
      },
      availableContracts: [],
      access: owner
    });

    expect(result).toEqual({
      operations: [],
      scope: { access: "contract", contracts: [] },
      replicaMode: "read_write",
      fileCapability: {
        kind: "files",
        protocol_version: 1,
        actions: ["list", "read", "add"],
        scope: { kind: "selected_folders", folders: ["Assets"] }
      }
    });
  });

  it("rejects an operation the application did not request", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["delete"],
      applicationOperationCeiling: ["read"],
      requirements: { contracts: [], access: "full_collection" },
      availableContracts: [],
      access: owner
    })).toThrow("must be requested");
  });

  it("rejects an operation outside the approving user's ceiling", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["update"],
      applicationOperationCeiling: ["update"],
      requirements: { contracts: [], access: "full_collection" },
      availableContracts: [],
      access: restricted(owner, ["read"], owner.scopeCeiling)
    })).toThrow("approving user");
  });

  it("rejects full-collection access from a contract-scoped member", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["read"],
      applicationOperationCeiling: ["read"],
      requirements: { contracts: [], access: "full_collection" },
      availableContracts: [contract],
      access: restricted(owner, ["read"], {
        access: "contract",
        contracts: [contract]
      })
    })).toThrow("full-collection");
  });

  it("rejects required contracts outside a member's scope", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["read"],
      applicationOperationCeiling: ["read"],
      requirements: {
        contracts: [{ id: contract.id, version: contract.version, digest: contract.digest }]
      },
      availableContracts: [contract],
      access: restricted(owner, ["read"], {
        access: "contract",
        contracts: []
      })
    })).toThrow("required contracts");
  });

  it("does not treat a drifted contract digest as the same delegated scope", () => {
    expect(() => planCollectionGrant({
      requestedOperations: ["read"],
      applicationOperationCeiling: ["read"],
      requirements: {
        contracts: [{ id: contract.id, version: contract.version, digest: contract.digest }]
      },
      availableContracts: [contract],
      access: restricted(owner, ["read"], {
        access: "contract",
        contracts: [{ ...contract, digest: `sha256:${"b".repeat(64)}` }]
      })
    })).toThrow("required contracts");
  });
});

function restricted(
  source: CollectionAccessContext,
  operations: CollectionOperation[],
  scopeCeiling: GrantScope
): CollectionAccessContext {
  return {
    ...source,
    relationship: "member",
    operationCeiling: new Set(operations),
    scopeCeiling
  };
}
