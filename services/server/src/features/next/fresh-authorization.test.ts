import { describe, expect, it } from "vitest";
import { APPLICATION_CAPABILITY_DEFINITIONS, type CollectionOperation } from "@mdbase-dev/connect-protocol";
import type { ApplicationRequirements } from "../../application-requirements.js";
import { ownerAccess } from "../../collection-access.js";
import type { DatabaseQueryable } from "../../database-types.js";
import { planCollectionGrant } from "../../grant-planner.js";
import { registerApplicationManifest } from "../../manifest.js";
import { exactNextGrantCapabilities } from "./grant-policy.js";
import { freshLegacyNextOperations, planFreshNextGrant } from "./fresh-authorization.js";

const read = [...APPLICATION_CAPABILITY_DEFINITIONS["collection.read"]];
const requirements: ApplicationRequirements = {
  contracts: [], access: "full_collection",
  capabilities: { contract_version: 1, required: ["collection.inspect", "records.watch", "records.read", "records.query", "views.list", "views.execute", "views.source.read", "records.validate", "definitions.read", "files.list", "files.read", "files.add"], optional: ["records.create", "records.update", "records.rename", "records.delete"] },
  files: { actions: ["list", "read", "add"], scope: { kind: "selected_folders", folders: ["attachments"] } }
};
const requestedOperations: CollectionOperation[] = [...read, "create", "update", "rename", "delete"];
const owner = ownerAccess({ collectionId: "collection", authorityKind: "hosted", authorityRowId: "collection", ownerUserId: "owner", authorityEpoch: 1, authorityState: "active", displayName: "Test" }, "owner");

describe("fresh legacy next approval", () => {
  it("drops only optional unrepresentable rights and keeps the signed v1 requirements intact", async () => {
    expect(() => registerApplicationManifest({ manifest_version: 1, id: "dev.example.reader", name: "Reader", distribution: "web", homepage: "https://reader.example", redirect_uris: ["https://reader.example/callback"], requirements })).not.toThrow();
    const original = structuredClone(requirements);
    const input = { requirements, requestedOperations, applicationOperationCeiling: requestedOperations, access: owner };
    const db = { query: async () => ({ rows: [{}] }) } as unknown as DatabaseQueryable;
    const result = await planFreshNextGrant(db, "collection", input);
    expect(result.plan.operations).toEqual([...read, "create"]);
    expect(result.plan.fileCapability?.actions).toEqual(["list", "read", "add"]);
    expect(result.plan.fileCapability?.scope).toEqual({ kind: "selected_folders", folders: ["attachments"] });
    expect(result.legacy?.requirements).toBe(requirements);
    expect(requirements).toEqual(original);
    expect(() => freshLegacyNextOperations({ requirements, requestedOperations }, read)).toThrow("This app needs an update");
    expect(() => freshLegacyNextOperations({ requirements, requestedOperations }, [...requestedOperations, "sync"])).toThrow("This app needs an update");
    const files = result.plan.fileCapability!;
    expect(() => exactNextGrantCapabilities(1, result.plan.operations, files)).toThrow("This app needs an update");
    expect(exactNextGrantCapabilities(1, result.plan.operations, files, true)).toEqual(["collection.read", "records.create"]);
    expect(() => exactNextGrantCapabilities(1, requestedOperations, files, true)).toThrow("This app needs an update");
  });

  it("does not project an ordinary legacy collection or mutate a retained plan", async () => {
    const input = { requirements, requestedOperations, applicationOperationCeiling: requestedOperations, access: owner };
    const db = { query: async () => ({ rows: [] }) } as unknown as DatabaseQueryable;
    expect(await planFreshNextGrant(db, "collection", input)).toEqual({ plan: planCollectionGrant(input) });
    expect(planCollectionGrant(input).operations).toEqual(requestedOperations);
  });
});
