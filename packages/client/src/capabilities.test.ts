import { describe, expect, it } from "vitest";
import type { MdbaseAppManifest } from "@mdbase-dev/connect-protocol";
import { effectiveCapabilities } from "./capabilities.js";
import type { MdbaseConnectionInfo } from "./connection-types.js";

const manifest: MdbaseAppManifest = {
  manifest_version: 1,
  id: "dev.mdbase.capability-test",
  name: "Capability test",
  homepage: "https://capability.example/",
  redirect_uris: ["https://capability.example/callback"],
  requirements: {
    access: "full_collection",
    contracts: [],
    capabilities: {
      contract_version: 2,
      required: ["collection.read"],
      optional: ["offline.replica"]
    }
  }
};

function connection(operations: string[]): MdbaseConnectionInfo {
  return {
    collectionId: "00000000-0000-0000-0000-000000000042",
    displayName: "Connector collection",
    operations: operations as MdbaseConnectionInfo["operations"],
    scope: { contracts: [], access: "full_collection" },
    authority: { kind: "connector", durability: "computer" },
    route: "relay",
    directAccess: "disabled"
  };
}

describe("effectiveCapabilities", () => {
  it("requires every internal operation in an atomic read capability", () => {
    const capabilities = effectiveCapabilities(
      manifest.requirements!.capabilities!,
      manifest,
      connection(["describe"])
    );

    expect(capabilities.requiredAvailable).toBe(false);
    expect(capabilities.values["collection.read"]).toMatchObject({
      state: "requires_authorization",
      missingOperations: expect.arrayContaining(["changes", "read", "query"])
    });
  });

  it("requires reauthorization for legacy contract-scoped grants", () => {
    const scoped = connection([
      "describe",
      "changes",
      "read",
      "query",
      "list_views",
      "execute_view",
      "read_view_source",
      "validate",
      "read_type"
    ]);
    scoped.scope = { access: "contract", contracts: [] };

    const capabilities = effectiveCapabilities(
      manifest.requirements!.capabilities!,
      manifest,
      scoped
    );

    expect(capabilities.requiredAvailable).toBe(false);
    expect(capabilities.values["collection.read"]).toMatchObject({
      state: "requires_authorization",
      reason: expect.stringContaining("reauthorized for the entire collection")
    });
  });

  it("recognizes connector-backed offline replication when the authority grants sync", () => {
    const capabilities = effectiveCapabilities(
      manifest.requirements!.capabilities!,
      manifest,
      connection([
        "describe",
        "changes",
        "read",
        "query",
        "list_views",
        "execute_view",
        "read_view_source",
        "validate",
        "read_type",
        "sync"
      ])
    );

    expect(capabilities.values["offline.replica"]).toMatchObject({
      state: "available",
      details: { durability: "device", writes: "queued", authority: "connector" }
    });
  });

  it("reports authorization, rather than topology, when sync was not granted", () => {
    const capabilities = effectiveCapabilities(
      manifest.requirements!.capabilities!,
      manifest,
      connection([
        "describe",
        "changes",
        "read",
        "query",
        "list_views",
        "execute_view",
        "read_view_source",
        "validate",
        "read_type"
      ])
    );

    expect(capabilities.values["offline.replica"]).toMatchObject({
      state: "requires_authorization",
      missingOperations: ["sync"]
    });
  });
});
