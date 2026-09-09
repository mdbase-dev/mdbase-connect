import { afterEach, expect, it, vi } from "vitest";
import { capabilityOperationsForContractVersion } from "@mdbase-dev/connect-protocol";
import { approveHostedAuthorization } from "./features/authorizations/approval-service.js";
import { HostedProviderClient } from "./hosted-provider.js";
import type { DatabasePool } from "./db.js";
import type { CollectionAccessContext } from "./collection-access.js";

afterEach(() => vi.restoreAllMocks());
it("v2-enabled approval refuses a prelude provider before any setup, replica or approval effect", async () => {
  // Exercise the real enablement policy; reader support alone is not fresh support.
  const pending = {
    requirements: { contracts: [], access: "full_collection", capabilities: { contract_version: 2, required: ["collection.read"] } },
    requested_operations: capabilityOperationsForContractVersion(2, "collection.read"),
    notifications: { criteria: [] }, provisions: { type_packs: [], configuration: [] }
  };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM authorization_requests") ? [pending] : [] }));
  const connection = { query, release: vi.fn() };
  const db = { connect: async () => connection } as unknown as DatabasePool;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ status: "ready", provider: {
    capabilities: ["application-setup-evidence-v2"], contract_support: { semantic_capabilities: [2, 1] }
  } }));
  const provider = new HostedProviderClient({ url: "https://provider.example", internalToken: "test" });
  const setup = vi.spyOn(provider, "provisionApplicationSetup");
  const register = vi.spyOn(provider, "registerReplica");
  const update = vi.spyOn(provider, "updateApplicationReplica");
  await expect(approveHostedAuthorization(db, provider, { requestId: "pending", userId: "owner", collectionId: "selected",
    operations: [], contracts: [], contractSetups: [], access: {} as CollectionAccessContext
  })).rejects.toThrow("hosted storage provider");
  expect(setup).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  expect(query.mock.calls.map(([sql]) => sql.trim().split(/\s/u)[0])).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);
});
