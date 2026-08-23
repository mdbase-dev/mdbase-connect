import type {
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionOperation,
  FileCapability,
  GrantScope,
  ReplicaCollaborationCapability
} from "@mdbase-dev/connect-protocol";
import {
  FILE_PROTOCOL_VERSION,
  requestsRecordCollaboration
} from "@mdbase-dev/connect-protocol";
import type { CollectionAccessContext } from "./collection-access.js";
import {
  requiresFullCollectionAccess,
  requiresWriteReplica
} from "./collection-operation-policy.js";

const WRITE_FILE_ACTIONS = new Set(["add", "replace", "move", "delete"]);

export interface GrantPlan {
  operations: CollectionOperation[];
  scope: GrantScope;
  replicaMode: "read_only" | "read_write";
  fileCapability?: FileCapability;
  collaborationCapability?: ReplicaCollaborationCapability;
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
  collaborationSupported?: boolean;
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
    assertFileRequirementWithinCeiling(fileRequirement, input.access.fileCeiling);
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
    && operations.some(requiresFullCollectionAccess)
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
  const collaborationCapability = collaborationCapabilityForGrant({
    requirements: input.requirements,
    operations,
    access: input.access,
    supported: input.collaborationSupported === true
  });
  return {
    operations,
    scope,
    replicaMode: operations.some(requiresWriteReplica)
      || fileRequirement?.actions.some((action) => WRITE_FILE_ACTIONS.has(action))
      ? "read_write"
      : "read_only",
    ...(fileCapability ? { fileCapability } : {}),
    ...(collaborationCapability ? { collaborationCapability } : {})
  };
}

function collaborationCapabilityForGrant(input: {
  requirements: ApplicationRequirements;
  operations: readonly CollectionOperation[];
  access: CollectionAccessContext;
  supported: boolean;
}): ReplicaCollaborationCapability | undefined {
  if (
    !input.supported
    || !requestsRecordCollaboration(input.requirements.capabilities)
    || !input.access.collaborationCeiling
    || !input.operations.includes("read")
  ) return undefined;
  const write = input.operations.includes("update")
    && input.access.collaborationCeiling.access === "read_write";
  return {
    contract_version: 1,
    profiles: ["markdown-body-yjs-v13"],
    access: write ? "read_write" : "read_only"
  };
}

function assertFileRequirementWithinCeiling(
  requirement: NonNullable<ApplicationRequirements["files"]>,
  ceiling: FileCapability
): void {
  const allowedActions = new Set(ceiling.actions);
  if (requirement.actions.some((action) => !allowedActions.has(action))) {
    throw new GrantPlanningError(
      "The approving user may not grant one or more requested file actions."
    );
  }
  if (ceiling.scope.kind === "collection") return;
  if (requirement.scope.kind === "collection") {
    throw new GrantPlanningError(
      "The approving user may not grant collection-wide file access."
    );
  }
  const allowedFolders = new Set(ceiling.scope.folders);
  if (requirement.scope.folders.some((folder) => !allowedFolders.has(folder))) {
    throw new GrantPlanningError(
      "The approving user may not grant access to one or more requested file folders."
    );
  }
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
