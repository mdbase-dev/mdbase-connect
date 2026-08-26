import type { CollectionOperation } from "./operations.js";

export const LEGACY_APPLICATION_CAPABILITY_CONTRACT_VERSION = 1 as const;
export const APPLICATION_CAPABILITY_CONTRACT_VERSION = 2 as const;

/**
 * Stable v1 application-facing abilities. This map is immutable: v1 validators
 * and clients must never begin accepting collaboration implicitly.
 */
export const APPLICATION_CAPABILITY_DEFINITIONS_V1 = {
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

/**
 * V2 adds room intent without translating it to `update`. Exact read/write
 * room access is negotiated and bound independently from operation authority.
 */
export const APPLICATION_CAPABILITY_DEFINITIONS_V2 = {
  ...APPLICATION_CAPABILITY_DEFINITIONS_V1,
  "records.collaborate": []
} as const satisfies Record<string, readonly CollectionOperation[]>;

/** Current definitions; retained export name for existing callers. */
export const APPLICATION_CAPABILITY_DEFINITIONS = APPLICATION_CAPABILITY_DEFINITIONS_V2;

export type ApplicationCapabilityIdV1 = keyof typeof APPLICATION_CAPABILITY_DEFINITIONS_V1;
export type ApplicationCapabilityId = keyof typeof APPLICATION_CAPABILITY_DEFINITIONS_V2;

export interface ApplicationCapabilityRequirementsV1 {
  contract_version: typeof LEGACY_APPLICATION_CAPABILITY_CONTRACT_VERSION;
  required: ApplicationCapabilityIdV1[];
  optional?: ApplicationCapabilityIdV1[];
}

export interface ApplicationCapabilityRequirementsV2 {
  contract_version: typeof APPLICATION_CAPABILITY_CONTRACT_VERSION;
  required: ApplicationCapabilityId[];
  optional?: ApplicationCapabilityId[];
}

export type ApplicationCapabilityRequirements =
  | ApplicationCapabilityRequirementsV1
  | ApplicationCapabilityRequirementsV2;

export function operationsForApplicationCapabilities(
  requirements: ApplicationCapabilityRequirements,
  options: { includeOptional?: boolean } = {}
): CollectionOperation[] {
  const capabilities = options.includeOptional === false
    ? requirements.required
    : [...requirements.required, ...(requirements.optional ?? [])];
  const definitions = requirements.contract_version === 1
    ? APPLICATION_CAPABILITY_DEFINITIONS_V1
    : APPLICATION_CAPABILITY_DEFINITIONS_V2;
  return [...new Set(capabilities.flatMap((capability) =>
    definitions[capability as keyof typeof definitions]
  ))];
}

export function capabilityOperations(
  capability: ApplicationCapabilityId,
  contractVersion: 1 | 2 = APPLICATION_CAPABILITY_CONTRACT_VERSION
): CollectionOperation[] {
  if (
    contractVersion === LEGACY_APPLICATION_CAPABILITY_CONTRACT_VERSION
    && !(capability in APPLICATION_CAPABILITY_DEFINITIONS_V1)
  ) throw new Error("Capability is unavailable in application capability contract v1.");
  return [...APPLICATION_CAPABILITY_DEFINITIONS_V2[capability]];
}

export function requestsRecordCollaboration(
  requirements: ApplicationCapabilityRequirements | undefined,
  options: { includeOptional?: boolean } = {}
): boolean {
  if (!requirements || requirements.contract_version !== 2) return false;
  const capabilities = options.includeOptional === false
    ? requirements.required
    : [...requirements.required, ...(requirements.optional ?? [])];
  return capabilities.includes("records.collaborate");
}
