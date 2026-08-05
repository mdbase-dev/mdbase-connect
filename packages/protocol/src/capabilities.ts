import type { CollectionOperation } from "./operations.js";

export const APPLICATION_CAPABILITY_CONTRACT_VERSION = 1 as const;

/**
 * Stable application-facing abilities. Applications declare intent in these
 * terms; Connect alone translates them into wire-level collection operations.
 */
export const APPLICATION_CAPABILITY_DEFINITIONS = {
  "collection.inspect": ["describe"],
  "records.watch": ["changes"],
  "records.read": ["read"],
  "records.query": ["query"],
  "records.validate": ["validate"],
  "records.create": ["create"],
  "records.update": ["update"],
  "records.delete": ["delete"],
  "records.rename": ["rename"],
  "views.list": ["list_views"],
  "views.execute": ["execute_view"],
  "views.source.read": ["read_view_source"],
  "views.source.create": ["create_view_source"],
  "views.source.update": ["update_view_source"],
  "views.source.delete": ["delete_view_source"],
  "definitions.contracts.current": [],
  "definitions.read": ["read_type"],
  "definitions.create": ["create_type"],
  "definitions.update": ["update_type"],
  "definitions.type-pack.inspect": ["assess_type_pack"],
  "definitions.type-pack.apply": ["assess_type_pack", "apply_type_pack"],
  "collection.setup.apply": ["assess_collection_setup", "apply_collection_setup"],
  "timers.list": ["list_timers"],
  "timers.put": ["put_timer"],
  "timers.cancel": ["cancel_timer"],
  "timers.reconcile": ["reconcile_timers"],
  "sync.offline-replica": ["sync"],
  "notifications.background-delivery": [],
  "files.list": [],
  "files.read": [],
  "files.add": [],
  "files.replace": [],
  "files.move": [],
  "files.delete": []
} as const satisfies Record<string, readonly CollectionOperation[]>;

export type ApplicationCapabilityId = keyof typeof APPLICATION_CAPABILITY_DEFINITIONS;

export interface ApplicationCapabilityRequirements {
  contract_version: typeof APPLICATION_CAPABILITY_CONTRACT_VERSION;
  required: ApplicationCapabilityId[];
  optional?: ApplicationCapabilityId[];
}

export function operationsForApplicationCapabilities(
  requirements: ApplicationCapabilityRequirements,
  options: { includeOptional?: boolean } = {}
): CollectionOperation[] {
  const capabilities = options.includeOptional === false
    ? requirements.required
    : [...requirements.required, ...(requirements.optional ?? [])];
  return [...new Set(capabilities.flatMap(
    (capability) => APPLICATION_CAPABILITY_DEFINITIONS[capability]
  ))];
}

export function capabilityOperations(
  capability: ApplicationCapabilityId
): CollectionOperation[] {
  return [...APPLICATION_CAPABILITY_DEFINITIONS[capability]];
}
