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
  /** Present only for next's jointly consented record/file capability groups. */
  fileActions?: readonly ApplicationFileAction[];
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
        description: "",
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

// Without a saved review, a declared-optional higher-impact capability starts
// denied so destructive or structural access is an explicit choice. Exact v1
// operations cannot distinguish required from optional, so they start selected.
export function selectedOperationsForCapabilityGroups(
  groups: readonly AuthorizationCapabilityGroup[],
  savedOperations?: readonly string[]
): Set<string> {
  if (!savedOperations) {
    return new Set(groups.flatMap((group) =>
      group.required || group.semantics === "exact" || !group.higherImpact ? group.operations : []
    ));
  }
  const saved = new Set(savedOperations);
  return new Set(groups.flatMap((group) =>
    group.required || group.operations.every((operation) => saved.has(operation))
      ? group.operations
      : []
  ));
}

const NEXT_FILES: Partial<Record<ApplicationCapabilityId, readonly ApplicationFileAction[]>> = {
  "collection.read": ["list", "read"], "records.create": ["add"],
  "records.edit": ["replace", "move"], "records.delete": ["delete"]
};
const NEXT_COPY: Partial<Record<ApplicationCapabilityId, { label: string; description: string }>> = {
  "collection.read": { label: "Read records and files", description: "Open, search, validate, and follow records and saved views; list file names and read file contents." },
  "records.create": { label: "Create records and add files", description: "Add new records and files to this collection." },
  "records.edit": { label: "Edit records and files", description: "Change, move, and rename records; replace, move, and rename existing files." },
  "records.delete": { label: "Delete records and files", description: "Permanently delete records and files from this collection." }
};

/** Refuse undeclared rights instead of manufacturing file or record consent. */
export function nextAuthorizationGroups(requirements: ApplicationRequirements, requested: readonly string[]): { groups: AuthorizationCapabilityGroup[]; error?: string } {
  const groups = authorizationCapabilityGroups(requirements, requested);
  const refuse = { groups: [], error: "This application must update its permissions and request access again. The next runtime requires records and their matching file actions to be approved together." };
  if (authorizationRequirementsError(requirements) || requirements.capabilities?.contract_version !== 2) return refuse;
  const files = requirements.files;
  if (files && "actions" in files) return refuse;
  const declaredFiles = new Set(files ? [...files.required, ...(files.optional ?? [])] : []);
  const requiredFiles = new Set(files?.required ?? []);
  const result = groups.map(group => {
    const id = group.id as ApplicationCapabilityId;
    const fileActions = NEXT_FILES[id] ?? [];
    return { ...group, ...NEXT_COPY[id], fileActions, required: group.required || fileActions.some(action => requiredFiles.has(action)) };
  });
  if (result.some(group => group.id === "offline.replica" || !group.fileActions.every(action => declaredFiles.has(action)))
      || [...requiredFiles].some(action => !result.some(group => group.fileActions.includes(action)))) return refuse;
  return { groups: result };
}

/** Optional saved groups restore only when both halves were explicitly approved. */
export function selectedNextAuthorizationOperations(groups: readonly AuthorizationCapabilityGroup[], savedOperations?: readonly string[], savedFiles?: readonly string[]): Set<string> {
  const operations = selectedOperationsForCapabilityGroups(groups, savedOperations);
  if (savedOperations || savedFiles) {
    for (const group of groups) {
      if (!group.required && !(group.fileActions ?? []).every(action => savedFiles?.includes(action))) {
        for (const operation of group.operations) operations.delete(operation);
      }
    }
  }
  return operations;
}

export const HIGHER_IMPACT_FILE_ACTIONS: ReadonlySet<ApplicationFileAction> = new Set(["delete"]);

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
      : (files.optional ?? []).filter((action) => !HIGHER_IMPACT_FILE_ACTIONS.has(action)))
  ]);
}

type PeopleRequirement = import("@mdbase-dev/connect-protocol").ApplicationPeopleRequirement;

/** Seeing other members' account identifiers discloses more than one's own. */
export const HIGHER_IMPACT_PEOPLE_PERMISSIONS: ReadonlySet<string> = new Set(["members"]);

/** Required permissions, plus optional ones from a saved review or the lower-impact default. */
export function selectedPeoplePermissions(
  people: PeopleRequirement,
  savedPermissions?: readonly string[]
): Set<string> {
  const declaredOptional = new Set<string>(people.optional ?? []);
  return new Set([
    ...(people.required ?? []),
    ...(savedPermissions
      ? savedPermissions.filter((permission) => declaredOptional.has(permission))
      : [...declaredOptional].filter((permission) => !HIGHER_IMPACT_PEOPLE_PERMISSIONS.has(permission)))
  ]);
}
