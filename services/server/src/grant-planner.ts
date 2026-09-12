import { collectionGrantScope, isCanonicalCollectionGrantScope } from "./application-grant-scope.js";
import type {
  CollectionOperation,
  FileAction,
  FileCapability,
  GrantScope
} from "@mdbase-dev/connect-protocol";
import {
  APPLICATION_SETUP_OPERATIONS,
  capabilityOperations,
  FILE_PROTOCOL_VERSION,
  applicationOperationSelectionIsAtomic
} from "@mdbase-dev/connect-protocol";
import type { CollectionAccessContext } from "./collection-access.js";
import { requiresWriteReplica } from "./collection-operation-policy.js";

import { fileRequestForRequirements, legacyOperationSelectionAllowed, requirementContractVersion, type ApplicationRequirements } from "./application-requirements.js";

const WRITE_FILE_ACTIONS = new Set(["add", "replace", "move", "delete"]);

export interface GrantPlan {
  operations: CollectionOperation[];
  scope: GrantScope;
  replicaMode: "read_only" | "read_write";
  fileCapability?: FileCapability;
}

/** Consent choices are a preview; approval rechecks the current locked policy. */
export function previewCollectionGrant(input: {
  applicationOperationCeiling: readonly CollectionOperation[];
  requirements: ApplicationRequirements;
  access: CollectionAccessContext;
}): { available: true; operations: CollectionOperation[]; file_actions: FileAction[] }
  | { available: false; detail: string } {
  const allowed = new Set(input.applicationOperationCeiling.filter((operation) =>
    input.access.operationCeiling.has(operation)
  ));
  const declared = input.requirements.capabilities;
  const operations = declared?.contract_version === 2
    ? [...new Set([
        ...[...declared.required, ...(declared.optional ?? [])].flatMap((capability) => {
          const group = capabilityOperations(capability);
          return group.every((operation) => allowed.has(operation)) ? group : [];
        }),
        ...APPLICATION_SETUP_OPERATIONS.filter((operation) => allowed.has(operation))
      ])]
    : [...allowed];
  const files = fileRequestForRequirements(input.requirements);
  try {
    const plan = planCollectionGrant({
      ...input,
      requestedOperations: operations,
      ...(files ? {
        requestedFileActions: files.actions.filter((action) =>
          input.access.fileCeiling.actions.includes(action)
        )
      } : {})
    });
    return { available: true, operations: plan.operations, file_actions: plan.fileCapability?.actions ?? [] };
  } catch (error) {
    if (!(error instanceof GrantPlanningError)) throw error;
    return {
      available: false,
      detail: "Your access to this collection does not include the permissions this application requires."
    };
  }
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
  const version = requirementContractVersion(input.requirements);
  const requestedFiles = fileRequestForRequirements(input.requirements);
  const selectedFileActions = input.requestedFileActions
    ? [...new Set(input.requestedFileActions)]
    : requestedFiles?.actions;
  if (operations.length === 0 && !fileRequirement) {
    throw new GrantPlanningError("At least one record operation or file capability must be approved.");
  }
  if (fileRequirement && "actions" in fileRequirement) {
    if (fileRequirement.actions.length === 0
      || new Set(fileRequirement.actions).size !== fileRequirement.actions.length
      || (selectedFileActions?.length !== fileRequirement.actions.length)
      || fileRequirement.actions.some((action) => !selectedFileActions?.includes(action))) {
      throw new GrantPlanningError("Legacy file actions must be approved exactly as declared.");
    }
  }
  if (fileRequirement && !("actions" in fileRequirement)) {
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
      (!("actions" in fileRequirement) && fileRequirement.required.some((action) => !selectedFileActions.includes(action)))
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
  if (version === 1 && !legacyOperationSelectionAllowed(input.requirements, operations)) {
    throw new GrantPlanningError("Approved operations exceed the legacy declaration.");
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
  if (!isCanonicalCollectionGrantScope(input.access.scopeCeiling)) {
    throw new GrantPlanningError("The approving user may not grant full-collection access.");
  }
  const setupOperations = new Set<string>(APPLICATION_SETUP_OPERATIONS);
  const semanticOperations = operations.filter((operation) => !setupOperations.has(operation));
  if (
    version === 2 && (input.requirements.capabilities?.contract_version === 2
      ? !applicationOperationSelectionIsAtomic(
          input.requirements.capabilities,
          semanticOperations
        )
      : semanticOperations.length > 0)
  ) {
    throw new GrantPlanningError(
      "Capability groups must be approved or denied as complete groups."
    );
  }
  if (version === 2 && APPLICATION_SETUP_OPERATIONS.some(
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
  if (fileCapability) {
    assertFileRequirementWithinCeiling(fileCapability, input.access.fileCeiling);
  }
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

function assertFileRequirementWithinCeiling(
  requirement: FileCapability,
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
  requirements: ApplicationRequirements,
  actions?: readonly FileAction[]
): FileCapability | undefined {
  const files = fileRequestForRequirements(requirements);
  return files
    ? {
        kind: "files",
        protocol_version: FILE_PROTOCOL_VERSION,
        actions: [...(actions ?? files.actions)],
        scope: structuredClone(files.scope)
      }
    : undefined;
}

export class GrantPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantPlanningError";
  }
}
