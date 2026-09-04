import { collectionGrantScope } from "./application-grant-scope.js";
import type {
  ApplicationRequirements,
  CollectionOperation,
  FileAction,
  FileCapability,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import {
  APPLICATION_SETUP_OPERATIONS,
  FILE_PROTOCOL_VERSION,
  applicationFileRequest,
  applicationOperationSelectionIsAtomic
} from "@mdbase-dev/connect-protocol";
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
  requestedFileActions?: readonly FileAction[];
  requirements: ApplicationRequirements;
  access: CollectionAccessContext;
}): GrantPlan {
  const operations = [...new Set(input.requestedOperations)];
  const fileRequirement = input.requirements.files;
  const requestedFiles = fileRequirement
    ? applicationFileRequest(fileRequirement)
    : undefined;
  const selectedFileActions = input.requestedFileActions
    ? [...new Set(input.requestedFileActions)]
    : requestedFiles?.actions;
  if (operations.length === 0 && !fileRequirement) {
    throw new GrantPlanningError("At least one record operation or file capability must be approved.");
  }
  if (fileRequirement) {
    if (
      fileRequirement.required.length === 0
      || new Set(fileRequirement.required).size !== fileRequirement.required.length
      || new Set(fileRequirement.optional ?? []).size !== (fileRequirement.optional ?? []).length
      || (fileRequirement.optional ?? []).some((action) => fileRequirement.required.includes(action))
    ) {
      throw new GrantPlanningError("File requirements need disjoint, unique required and optional actions.");
    }
  }
  if (fileRequirement && selectedFileActions) {
    const declaredActions = new Set(requestedFiles?.actions ?? []);
    if (
      fileRequirement.required.some((action) => !selectedFileActions.includes(action))
      || selectedFileActions.some((action) => !declaredActions.has(action))
    ) {
      throw new GrantPlanningError(
        "Required file actions must be approved and optional file actions must be declared."
      );
    }
  } else if (selectedFileActions?.length) {
    throw new GrantPlanningError(
      "File actions require an application file declaration."
    );
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
  const setupOperations = new Set<string>(APPLICATION_SETUP_OPERATIONS);
  const semanticOperations = operations.filter((operation) => !setupOperations.has(operation));
  if (
    input.requirements.capabilities
      ? !applicationOperationSelectionIsAtomic(
          input.requirements.capabilities,
          semanticOperations
        )
      : semanticOperations.length > 0
  ) {
    throw new GrantPlanningError(
      "Capability groups must be approved or denied as complete groups."
    );
  }
  if (APPLICATION_SETUP_OPERATIONS.some(
    (operation) => applicationOperations.has(operation) && !operations.includes(operation)
  )) {
    throw new GrantPlanningError(
      "Declared collection setup authority may not be partially denied."
    );
  }
  const scope: GrantScope = collectionGrantScope();
  const fileCapability = fileCapabilityForRequirements(
    input.requirements,
    selectedFileActions
  );
  return {
    operations,
    scope,
    replicaMode: operations.some(requiresWriteReplica)
      || selectedFileActions?.some((action) => WRITE_FILE_ACTIONS.has(action))
      ? "read_write"
      : "read_only",
    ...(fileCapability ? { fileCapability } : {})
  };
}

export function fileCapabilityForRequirements(
  requirements: ApplicationRequirements,
  actions?: readonly FileAction[]
): FileCapability | undefined {
  return requirements.files
    ? {
        kind: "files",
        protocol_version: FILE_PROTOCOL_VERSION,
        actions: [...(actions ?? applicationFileRequest(requirements.files).actions)],
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
