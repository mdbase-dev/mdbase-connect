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
    contracts: [],
    capabilities: {
      contract_version: 1,
      required: ["collection.inspect"],
      optional: ["sync.offline-replica"]
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
  it("treats full-collection authorization as approval of required contracts", () => {
    const contractManifest: MdbaseAppManifest = {
      ...manifest,
      requirements: {
        access: "full_collection",
        contracts: [{
          id: "mdbase.workouts.exercise",
          version: "1.0.0",
          digest: `sha256:${"a".repeat(64)}`
        }],
        capabilities: {
          contract_version: 1,
          required: ["definitions.contracts.current"]
        }
      }
    };

    const capabilities = effectiveCapabilities(
      contractManifest.requirements!.capabilities!,
      contractManifest,
      connection(["describe"])
    );

    expect(capabilities.requiredAvailable).toBe(true);
    expect(capabilities.values["definitions.contracts.current"]).toMatchObject({
      state: "available"
    });
  });

  it("still requires exact contract approval for contract-scoped grants", () => {
    const contractManifest: MdbaseAppManifest = {
      ...manifest,
      requirements: {
        access: "contract",
        contracts: [{
          id: "mdbase.workouts.exercise",
          version: "1.0.0",
          digest: `sha256:${"a".repeat(64)}`
        }],
        capabilities: {
          contract_version: 1,
          required: ["definitions.contracts.current"]
        }
      }
    };
    const scoped = connection(["describe"]);
    scoped.scope = { access: "contract", contracts: [] };

    const capabilities = effectiveCapabilities(
      contractManifest.requirements!.capabilities!,
      contractManifest,
      scoped
    );

    expect(capabilities.requiredAvailable).toBe(false);
    expect(capabilities.values["definitions.contracts.current"]).toMatchObject({
      state: "requires_authorization"
    });
  });

  it("recognizes connector-backed offline replication when the authority grants sync", () => {
    const capabilities = effectiveCapabilities(
      manifest.requirements!.capabilities!,
      manifest,
      connection(["describe", "sync"])
    );

    expect(capabilities.values["sync.offline-replica"]).toMatchObject({
      state: "available",
      details: { durability: "device", writes: "queued", authority: "connector" }
    });
  });

  it("reports authorization, rather than topology, when sync was not granted", () => {
    const capabilities = effectiveCapabilities(
      manifest.requirements!.capabilities!,
      manifest,
      connection(["describe"])
    );

    expect(capabilities.values["sync.offline-replica"]).toMatchObject({
      state: "requires_authorization",
      missingOperations: ["sync"]
    });
  });
});
