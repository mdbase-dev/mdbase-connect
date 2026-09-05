import { capabilityOperationsForContractVersion, type CollectionOperation } from "@mdbase-dev/connect-protocol";
import type { LegacyApplicationRequirements } from "@mdbase-dev/connect-protocol/manifest";

type Capability = NonNullable<LegacyApplicationRequirements["capabilities"]>["required"][number];

/** Explicit predecessor intents for semantic-neutral prelude lifecycle fixtures. */
export const LEGACY_READ_CAPABILITIES: Capability[] = [
  "collection.inspect", "records.watch", "records.read", "records.query",
  "records.validate", "definitions.read"
];
export function legacyOperations(capabilities: readonly Capability[]): CollectionOperation[] {
  return [...new Set(capabilities.flatMap((capability) => capabilityOperationsForContractVersion(1, capability)!))];
}
export const LEGACY_READ_OPERATIONS = legacyOperations(LEGACY_READ_CAPABILITIES);
