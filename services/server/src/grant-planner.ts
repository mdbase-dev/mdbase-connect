import type {
  ApplicationRequirements,
  CollectionOperation,
  FileCapability,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import { FILE_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import type { CollectionAccessContext } from "./collection-access.js";
import { requiresWriteReplica } from "./collection-operation-policy.js";

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
  if (input.requirements.access !== "full_collection") {
    throw new GrantPlanningError(
      "Applications must explicitly request full collection access; legacy or omitted access is not widened."
    );
  }

  const scope: GrantScope = { access: "full_collection", contracts: [] };
  const fileCapability = fileCapabilityForRequirements(input.requirements);
  return {
    operations,
    scope,
    replicaMode: operations.some(requiresWriteReplica)
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

export class GrantPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantPlanningError";
  }
}
