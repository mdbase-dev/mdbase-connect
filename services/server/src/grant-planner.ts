import type {
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionOperation,
  GrantScope
} from "@mdbase/connect-protocol";
import type { CollectionAccessContext } from "./collection-access.js";

const FULL_COLLECTION_OPERATIONS = new Set<CollectionOperation>([
  "validate",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type"
]);

const WRITE_OPERATIONS = new Set<CollectionOperation>([
  "create",
  "update",
  "delete",
  "rename",
  "create_type",
  "update_type",
  "create_view_source",
  "update_view_source",
  "delete_view_source",
  "put_timer",
  "cancel_timer",
  "reconcile_timers"
]);

export interface GrantPlan {
  operations: CollectionOperation[];
  scope: GrantScope;
  replicaMode: "read_only" | "read_write";
}

/**
 * Computes a capability from three independent ceilings: what the application
 * requested, what its manifest permits, and what the approving user may grant.
 * Keeping this pure makes future member roles an access-policy change rather
 * than another authorization flow.
 */
export function planCollectionGrant(input: {
  requestedOperations: readonly CollectionOperation[];
  applicationOperationCeiling: readonly CollectionOperation[];
  requirements: ApplicationRequirements;
  availableContracts: readonly CollectionContractDescriptor[];
  access: CollectionAccessContext;
}): GrantPlan {
  const operations = [...new Set(input.requestedOperations)];
  if (operations.length === 0) {
    throw new GrantPlanningError("At least one operation must be approved.");
  }
  const applicationOperations = new Set(input.applicationOperationCeiling);
  if (operations.some((operation) => !applicationOperations.has(operation))) {
    throw new GrantPlanningError(
      "Approved operations must be requested by the application."
    );
  }
  if (operations.some((operation) => !input.access.operationCeiling.has(operation))) {
    throw new GrantPlanningError(
      "The approving user may not grant one or more requested operations."
    );
  }
  if (
    input.requirements.access !== "full_collection"
    && input.requirements.contracts.length === 0
  ) {
    throw new GrantPlanningError(
      "Contract-scoped application manifests must declare at least one required contract; use full_collection for collection-wide access."
    );
  }
  if (
    input.requirements.access !== "full_collection"
    && operations.some((operation) => FULL_COLLECTION_OPERATIONS.has(operation))
  ) {
    throw new GrantPlanningError(
      "Saved views, collection-wide validation, and type definitions require the application manifest to request full collection access."
    );
  }

  const applicationScope = scopeForRequirements(
    input.requirements,
    input.availableContracts
  );
  const scope = intersectScope(applicationScope, input.access.scopeCeiling);
  return {
    operations,
    scope,
    replicaMode: operations.some((operation) => WRITE_OPERATIONS.has(operation))
      ? "read_write"
      : "read_only"
  };
}

function scopeForRequirements(
  requirements: ApplicationRequirements,
  available: readonly CollectionContractDescriptor[]
): GrantScope {
  if (requirements.access === "full_collection") {
    return { access: "full_collection", contracts: [] };
  }
  const required = new Set(
    requirements.contracts.map(({ id, version }) => `${id}@${version}`)
  );
  return {
    access: "contract",
    contracts: available.filter(({ id, version }) =>
      required.has(`${id}@${version}`)
    )
  };
}

function intersectScope(application: GrantScope, user: GrantScope): GrantScope {
  if (user.access === "full_collection") return application;
  if (application.access === "full_collection") {
    throw new GrantPlanningError(
      "The approving user may not grant full-collection access."
    );
  }
  const allowed = new Set(user.contracts.map(contractKey));
  if (application.contracts.some((contract) => !allowed.has(contractKey(contract)))) {
    throw new GrantPlanningError(
      "The approving user may not grant one or more required contracts."
    );
  }
  return application;
}

function contractKey(contract: CollectionContractDescriptor): string {
  const implementations = contract.implementations
    .map(({ type_name, type_version, digest }) =>
      `${type_name}@${type_version}:${digest}`
    )
    .sort()
    .join(",");
  return `${contract.id}@${contract.version}:${contract.digest}:${implementations}`;
}

export class GrantPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantPlanningError";
  }
}
