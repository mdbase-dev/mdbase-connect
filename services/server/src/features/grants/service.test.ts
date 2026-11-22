import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../db.js";
import type { RelayHub } from "../relay/relay.js";
import { reconcileApplicationGrants } from "./service.js";

const grantId = "00000000-0000-4000-8000-000000000002";
const applicationId = "00000000-0000-4000-8000-000000000003";
const applicationManifestDigest = "a".repeat(64);

describe("synced collection grants under application reconciliation", () => {
  // The MCP gateway's declaration (services/mcp/src/app.ts), unchanged.
  const gatewayRequirements = {
    access: "full_collection" as const,
    contracts: [],
    capabilities: {
      contract_version: 2 as const,
      required: ["collection.read" as const],
      optional: [
        "records.create" as const,
        "records.edit" as const,
        "records.delete" as const,
        "definitions.manage" as const
      ]
    },
    files: {
      required: ["list" as const, "read" as const],
      optional: ["add" as const, "replace" as const, "move" as const, "delete" as const],
      scope: { kind: "collection" as const }
    }
  };

  // The row the reconciliation query yields for a synced (next_collection_id)
  // grant: none of the collections or hosted_collections joins match it.
  function syncedGrant() {
    return {
      id: grantId,
      user_id: "00000000-0000-4000-8000-000000000006",
      connector_id: null,
      hosted_collection_id: null,
      hosted_replica_id: null,
      next_collection_id: "00000000-0000-4000-8000-000000000007",
      next_collection_sync: "cloud_copy",
      // read + create + edit: the twelve operations of the observed grant.
      operations: ["describe", "changes", "read", "query", "list_views", "execute_view",
        "read_view_source", "validate", "read_type", "create", "update", "rename"],
      local_contracts: null,
      spec_version: null,
      hosted_contracts: null,
      template: null,
      allowed_types: null,
      scope: { contracts: [], access: "full_collection" as const },
      notification_criteria: [],
      file_capability: {
        kind: "files" as const,
        protocol_version: 1 as const,
        actions: ["list", "read", "add", "replace"],
        scope: { kind: "collection" as const }
      }
    };
  }

  async function reconcile(requirements: typeof gatewayRequirements): Promise<string[]> {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      return sql.includes("FROM grants g")
        ? { rows: [syncedGrant()], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });
    await reconcileApplicationGrants(
      { query } as unknown as DatabasePool,
      { pushPolicy: vi.fn() } as unknown as RelayHub,
      {
        id: applicationId,
        family_identity: "bundle:dev.mdbase.mcp",
        manifest_digest: applicationManifestDigest,
        requirements,
        notifications: { criteria: [] }
      }
    );
    return statements.filter((sql) => /UPDATE (grants|refresh_tokens|access_tokens)/.test(sql));
  }

  it("keeps a cloud copy grant the unchanged declaration allows", async () => {
    expect(await reconcile(gatewayRequirements)).toEqual([]);
  });

  it("still retires a cloud copy grant whose file actions the declaration no longer allows", async () => {
    const narrowed = {
      ...gatewayRequirements,
      files: { ...gatewayRequirements.files, optional: ["add" as const] }
    };
    const writes = await reconcile(narrowed);
    expect(writes.some((sql) => sql.includes("UPDATE grants"))).toBe(true);
    expect(writes.some((sql) => sql.includes("UPDATE access_tokens"))).toBe(true);
  });
});
