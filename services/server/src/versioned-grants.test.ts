import { describe, expect, it } from "vitest";
import { APPLICATION_SETUP_OPERATIONS, CONNECT_CONTRACT_SUPPORT, authorizationContractRequirements, MDBASE_TIMER_FIRED_CONTRACT, operationsForApplicationCapabilities } from "@mdbase-dev/connect-protocol";
import type { CollectionOperation } from "@mdbase-dev/connect-protocol";
import type { LegacyApplicationCapabilityId } from "@mdbase-dev/connect-protocol";
import { canonicalSha256 } from "./canonical-json.js";
import { ownerAccess } from "./collection-access.js";
import { planCollectionGrant } from "./grant-planner.js";
import { registerApplicationManifest } from "./manifest.js";
import { assertOperationsAllowedByApplication, operationsAllowedByRequirements } from "./features/grants/policy.js";
import type { ApplicationRequirements } from "./application-requirements.js";

const owner = ownerAccess({ collectionId: "collection", authorityKind: "hosted", authorityRowId: "collection", ownerUserId: "owner", authorityEpoch: 1, authorityState: "active", displayName: "Fixture" }, "owner");
const declaration = (requirements: ApplicationRequirements) => ({
  manifest_version: 1, distribution: "portable", id: "dev.mdbase.version-fixture", name: "Version fixture", requirements
});
const legacy = (ids?: LegacyApplicationCapabilityId[]): ApplicationRequirements => ({
  access: "full_collection", contracts: [],
  ...(ids ? { capabilities: { contract_version: 1, required: ids } } : {})
});
const plan = (requirements: ApplicationRequirements, operations: CollectionOperation[]) => planCollectionGrant({
  requestedOperations: operations, applicationOperationCeiling: operations, requirements, access: owner
});

describe("explicit server declaration bridge", () => {
  it("signs explicit semantic versions without advertising bridge readiness", () => {
    expect(authorizationContractRequirements(["read"]).semantic_capabilities).toBe(2);
    expect(authorizationContractRequirements(["read"], undefined, [], 1).semantic_capabilities).toBe(1);
    expect(authorizationContractRequirements(["update"], undefined, [], 1).durable_mutation).toBe(1);
    expect(CONNECT_CONTRACT_SUPPORT.semantic_capabilities).toEqual([2, 1]);
  });
  it.each([
    ["records.read", "read", "query"],
    ["records.update", "update", "rename"],
    ["timers.reconcile", "reconcile_timers", "put_timer"]
  ] as const)("retains %s as exact predecessor authority", (capability, operation, denied) => {
    const registered = registerApplicationManifest(declaration(legacy([capability])));
    expect(registered.contractVersion).toBe(1);
    expect(registered.manifest.requirements).toEqual({ configuration: [], ...legacy([capability]) });
    expect(registered.digest).toBe(canonicalSha256(registered.manifest).slice(7));
    expect(plan(registered.manifest.requirements, [operation]).operations).toEqual([operation]);
    expect(operationsAllowedByRequirements([denied], registered.manifest.requirements)).toBe(false);
  });

  it("retains independently selected legacy required operations and setup aliases", () => {
    expect(plan(legacy(["records.read", "records.query"]), ["read"]).operations).toEqual(["read"]);
    expect(plan(legacy(["definitions.type-pack.apply"]), ["apply_type_pack"]).operations).toEqual(["apply_type_pack"]);
    expect(() => assertOperationsAllowedByApplication(["apply_collection_setup"], legacy(["collection.setup.apply"]), { criteria: [] })).not.toThrow();
    expect(plan(legacy(["collection.setup.apply"]), ["apply_collection_setup"]).operations).toEqual(["apply_collection_setup"]);
  });

  it("preserves no-capability requests without widening the selected operations", () => {
    const registered = registerApplicationManifest(declaration(legacy()));
    expect(registered.contractVersion).toBe(1);
    expect(registered.manifest.requirements.capabilities).toBeUndefined();
    expect(() => assertOperationsAllowedByApplication(["read"], registered.manifest.requirements, { criteria: [] })).not.toThrow();
    expect(plan(registered.manifest.requirements, ["read"]).operations).toEqual(["read"]);
  });

  it("keeps the timer notification ceiling for legacy single-operation requests", () => {
    const requirements = legacy(["timers.reconcile"]);
    expect(() => assertOperationsAllowedByApplication(["reconcile_timers"], requirements, { criteria: [] })).toThrow("notification criterion");
    expect(() => assertOperationsAllowedByApplication(["reconcile_timers"], requirements, {
      criteria: [{ id: "timer", event: MDBASE_TIMER_FIRED_CONTRACT }]
    })).not.toThrow();
  });

  it("retains files.actions and refuses partial legacy file approval", () => {
    const requirements: ApplicationRequirements = { ...legacy(["files.read", "files.add"]), files: { actions: ["read", "add"], scope: { kind: "collection" } } };
    const registered = registerApplicationManifest(declaration(requirements));
    expect(registered.manifest.requirements.files).toEqual(requirements.files);
    expect(plan(registered.manifest.requirements, []).fileCapability?.actions).toEqual(["read", "add"]);
    expect(() => planCollectionGrant({ requirements, requestedOperations: [], applicationOperationCeiling: [], requestedFileActions: ["read"], access: owner })).toThrow("exactly as declared");
  });

  it("requires complete v2 required groups and provision-derived setup", () => {
    const capabilities = { contract_version: 2 as const, required: ["records.edit" as const] };
    const requirements: ApplicationRequirements = { access: "full_collection", contracts: [], capabilities };
    const operations = operationsForApplicationCapabilities(capabilities);
    expect(plan(requirements, operations).operations).toEqual(["update", "rename"]);
    expect(() => plan(requirements, ["update"])).toThrow("complete groups");
    expect(operationsAllowedByRequirements(["update"], requirements)).toBe(false);
    expect(() => assertOperationsAllowedByApplication([...operations, ...APPLICATION_SETUP_OPERATIONS], requirements, { criteria: [] })).toThrow("declared provisions");
  });

  it.each([
    { capabilities: { contract_version: 1, required: ["records.edit"] } },
    { capabilities: { contract_version: 2, required: ["records.update"] } },
    { capabilities: { contract_version: 1, required: ["records.read"] }, files: { required: ["read"], scope: { kind: "collection" } } },
    { capabilities: { contract_version: 2, required: ["collection.read"] }, files: { actions: ["read"], scope: { kind: "collection" } } }
  ])("rejects mixed declarations before registration: %j", (mixed) => {
    expect(() => registerApplicationManifest({ ...declaration(legacy()), requirements: { access: "full_collection", contracts: [], ...mixed } })).toThrow("invalid");
  });
});
