import { groupAuthorizationOperations } from "@mdbase/connect-ui/access";
import {
  APPLICATION_CAPABILITY_V1_DEFINITIONS,
  capabilityOperations,
  type ApplicationCapabilityId
} from "@mdbase-dev/connect-protocol";
import type { ApplicationFileAction, ApplicationRequirements } from "./api";

export interface AuthorizationCapabilityGroup {
  id: string;
  semantics?: "exact";
  label: string;
  description: string;
  operations: string[];
  required: boolean;
  higherImpact: boolean;
}

const PRESENTATION: Record<ApplicationCapabilityId, {
  label: string;
  description: string;
  higherImpact?: boolean;
}> = {
  "collection.read": {
    label: "Read this collection",
    description: "Open, search, validate, and follow changes to records and saved views."
  },
  "records.create": {
    label: "Create records",
    description: "Add new records to this collection."
  },
  "records.edit": {
    label: "Edit records",
    description: "Change, move, and rename existing records."
  },
  "records.delete": {
    label: "Delete records",
    description: "Permanently delete records from this collection.",
    higherImpact: true
  },
  "views.manage": {
    label: "Manage saved views",
    description: "Create, change, and delete saved view definitions."
  },
  "definitions.manage": {
    label: "Manage definitions",
    description: "Create and update record types and apply declared type packs.",
    higherImpact: true
  },
  "background.schedule": {
    label: "Schedule background work",
    description: "Create and maintain timers that run while the application is closed."
  },
  "offline.replica": {
    label: "Keep an offline replica",
    description: "Synchronize an application-controlled local copy of this collection."
  }
};

// Inspect the wire declaration before constructing consent controls. Never interpret
// an unknown or mixed declaration as predecessor intent.
export function authorizationRequirementsError(requirements: ApplicationRequirements): string | undefined {
  const declared = requirements.capabilities;
  const version = declared?.contract_version;
  const files = requirements.files;
  const invalid = "This application requests an unsupported or mixed permission version. Access cannot be approved.";
  if (version !== undefined && version !== 1 && version !== 2) return invalid;
  if (declared && version === undefined) return invalid;
  const definitions = version === 2 ? PRESENTATION : APPLICATION_CAPABILITY_V1_DEFINITIONS;
  if (declared && (!Array.isArray(declared.required)
    || (declared.optional !== undefined && !Array.isArray(declared.optional))
    || [...declared.required, ...(declared.optional ?? [])].some((id) => !Object.hasOwn(definitions, id)))) return invalid;
  if (files) {
    if (version === 2) {
      if (!("required" in files) || "actions" in files || !Array.isArray(files.required)
        || (files.optional !== undefined && !Array.isArray(files.optional))) return invalid;
    } else if (!("actions" in files) || "required" in files || "optional" in files || !Array.isArray(files.actions)) return invalid;
  }
  return undefined;
}

export function authorizationCapabilityGroups(
  requirements: ApplicationRequirements,
  requestedOperations: readonly string[]
): AuthorizationCapabilityGroup[] {
  if (authorizationRequirementsError(requirements)) return [];
  const declared = requirements.capabilities;
  if (!declared || declared.contract_version === 1) {
    return groupAuthorizationOperations(requestedOperations).flatMap((group) =>
      group.operations.map((operation) => ({
        id: operation.id,
        semantics: "exact" as const,
        label: operation.label,
        description: `Allow the ${operation.id} operation.`,
        operations: [operation.id],
        required: false,
        higherImpact: group.id === "delete" || group.id === "manage"
      }))
    );
  }
  const requested = new Set(requestedOperations);
  const required = new Set<ApplicationCapabilityId>(declared.required);
  return [...declared.required, ...(declared.optional ?? [])].flatMap((id) => {
    const operations = capabilityOperations(id);
    if (!required.has(id) && !operations.every((operation) => requested.has(operation))) {
      return [];
    }
    const presentation = PRESENTATION[id];
    return [{
      id,
      ...presentation,
      operations,
      required: required.has(id),
      higherImpact: presentation.higherImpact === true
    }];
  });
}

export function toggleAuthorizationGroup(
  current: ReadonlySet<string>, group: AuthorizationCapabilityGroup
): Set<string> {
  const next = new Set(current);
  if (group.required) return next;
  const enabled = group.operations.every((operation) => next.has(operation));
  for (const operation of group.operations) {
    if (enabled) next.delete(operation);
    else next.add(operation);
  }
  return next;
}

export function selectedOperationsForCapabilityGroups(
  groups: readonly AuthorizationCapabilityGroup[],
  savedOperations?: readonly string[]
): Set<string> {
  if (!savedOperations) {
    return new Set(groups.flatMap((group) => group.operations));
  }
  const saved = new Set(savedOperations);
  return new Set(groups.flatMap((group) =>
    group.required || group.operations.every((operation) => saved.has(operation))
      ? group.operations
      : []
  ));
}

export function selectedFileActions(
  files: NonNullable<ApplicationRequirements["files"]>,
  savedActions?: readonly string[]
): Set<string> {
  if ("actions" in files) return new Set(files.actions);
  const declaredOptional = new Set(files.optional ?? []);
  return new Set([
    ...files.required,
    ...(savedActions
      ? savedActions.filter((action): action is ApplicationFileAction =>
          declaredOptional.has(action as ApplicationFileAction))
      : files.optional ?? [])
  ]);
}
