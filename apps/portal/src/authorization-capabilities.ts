import {
  capabilityOperations,
  type ApplicationCapabilityId
} from "@mdbase-dev/connect-protocol";
import type { ApplicationFileAction, ApplicationRequirements } from "./api";

export interface AuthorizationCapabilityGroup {
  id: ApplicationCapabilityId;
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

export function authorizationCapabilityGroups(
  requirements: ApplicationRequirements,
  requestedOperations: readonly string[]
): AuthorizationCapabilityGroup[] {
  const declared = requirements.capabilities;
  if (!declared) return [];
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
  const declaredOptional = new Set(files.optional ?? []);
  return new Set([
    ...files.required,
    ...(savedActions
      ? savedActions.filter((action): action is ApplicationFileAction =>
          declaredOptional.has(action as ApplicationFileAction))
      : files.optional ?? [])
  ]);
}
