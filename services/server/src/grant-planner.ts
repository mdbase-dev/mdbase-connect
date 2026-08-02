import type {
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionOperation,
  FileCapability,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import { FILE_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import type { CollectionAccessContext } from "./collection-access.js";

const FULL_COLLECTION_OPERATIONS = new Set<CollectionOperation>([
  "validate",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type",
  "apply_type_pack"
]);

const WRITE_OPERATIONS = new Set<CollectionOperation>([
  "create",
  "update",
  "delete",
  "rename",
  "create_type",
  "update_type",
  "apply_type_pack",
  "create_view_source",
  "update_view_source",
  "delete_view_source",
  "put_timer",
  "cancel_timer",
  "reconcile_timers"
]);

const WRITE_FILE_ACTIONS = new Set(["add", "replace", "move", "delete"]);

export interface GrantPlan {
  operations: CollectionOperation[];
  scope: GrantScope;
  replicaMode: "read_only" | "read_write";
  fileCapability?: FileCapability;
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
  const fileRequirement = input.requirements.files;
  if (operations.length === 0 && !fileRequirement) {
    throw new GrantPlanningError("At least one record operation or file capability must be approved.");
  }
  if (fileRequirement) {
    if (
      fileRequirement.actions.length === 0
      || new Set(fileRequirement.actions).size !== fileRequirement.actions.length
    ) {
      throw new GrantPlanningError("File capabilities require at least one unique action.");
    }
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
    operations.length > 0
    && input.requirements.access !== "full_collection"
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
  const fileCapability = fileCapabilityForRequirements(input.requirements);
  return {
    operations,
    scope,
    replicaMode: operations.some((operation) => WRITE_OPERATIONS.has(operation))
      || fileRequirement?.actions.some((action) => WRITE_FILE_ACTIONS.has(action))
      ? "read_write"
      : "read_only",
    ...(fileCapability ? { fileCapability } : {})
  };
}

export function fileCapabilityForRequirements(
  requirements: ApplicationRequirements
): FileCapability | undefined {
  return requirements.files
    ? {
        kind: "files",
        protocol_version: FILE_PROTOCOL_VERSION,
        actions: [...requirements.files.actions],
        scope: structuredClone(requirements.files.scope)
      }
    : undefined;
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
