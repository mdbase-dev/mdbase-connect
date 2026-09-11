import {
  capabilityOperations,
  type ApplicationCapabilityId
} from "@mdbase-dev/connect-protocol";

export interface RequestCapabilityGroup {
  id: ApplicationCapabilityId;
  label: string;
  description: string;
  operations: string[];
  required: boolean;
}

const CAPABILITY_COPY: Record<ApplicationCapabilityId, [string, string]> = {
  "collection.read": ["Read this collection", "Open, search, validate, and follow collection changes."],
  "records.create": ["Create records", "Add new records to this collection."],
  "records.edit": ["Edit records", "Change, move, and rename existing records."],
  "records.delete": ["Delete records", "Permanently delete records from this collection."],
  "views.manage": ["Manage saved views", "Create, change, and delete saved view definitions."],
  "definitions.manage": ["Manage definitions", "Create and update record types and declared type packs."],
  "background.schedule": ["Schedule background work", "Create and maintain application timers."],
  "offline.replica": ["Keep an offline replica", "Synchronize an application-controlled local copy."]
};

export function hasSupportedCapabilityDeclaration(
  requirements: ApplicationRequirements | null | undefined
): requirements is ApplicationRequirements & { capabilities: NonNullable<ApplicationRequirements["capabilities"]> } {
  return requirements?.capabilities?.contract_version === 2;
}

export function requestCapabilityGroups(
  requirements: ApplicationRequirements | null | undefined,
  operations: readonly string[]
): RequestCapabilityGroup[] {
  if (!hasSupportedCapabilityDeclaration(requirements)) return [];
  const declared = requirements.capabilities;
  const granted = new Set(operations);
  const required = new Set<ApplicationCapabilityId>(declared.required);
  return [...declared.required, ...(declared.optional ?? [])].flatMap((id) => {
    const groupOperations = capabilityOperations(id);
    if (!groupOperations.every((operation) => granted.has(operation))) return [];
    const [label, description] = CAPABILITY_COPY[id];
    return [{ id, label, description, operations: groupOperations, required: required.has(id) }];
  });
}
