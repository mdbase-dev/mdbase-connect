// The ONE verifier's accepted original H6 lineage, never a caller pre-fenced
// flag or an observed/latest run. No network effects or native readiness here.
import { createHash } from "node:crypto";
import type { LegacyMigrationDrain, LegacyNotificationWatermark } from "../../hosted-provider-replies.js";
import { RolloutRefused, SCOPED_HOSTED_ARCHIVE_SCHEMA, type VerifiedBatchArchive } from "./migration-archive-profile.js";
import { prearchiveInventory, type PrearchiveCapture } from "./migration-prearchive-inventory.js";

const refuse = (): never => { throw new RolloutRefused("migration_archive_source_changed", "The accepted original archive source is not current."); };

/** Caller holds the cohort lock; acquire no child/owner locks here. */
export function requireScopedArchiveCoverage(capture: PrearchiveCapture, result: VerifiedBatchArchive): void {
  if (result.schema !== SCOPED_HOSTED_ARCHIVE_SCHEMA) return;
  const inventory = prearchiveInventory(capture), proof = result.scoped_recovery;
  const pairs = inventory.selected.map(value => [value.account_id, value.collection_id]);
  const selection = createHash("sha256").update("mdbase-scoped-archive-selection/v1\n").update(JSON.stringify(pairs), "ascii").digest("hex");
  if (proof.inventory_sha256 !== inventory.inventory_sha256 || proof.selection_sha256 !== selection
      || proof.source_fences.length !== pairs.length) refuse();
  const runs = new Set<string>();
  for (let i = 0; i < pairs.length; i++) {
    const original = proof.source_fences[i]!;
    if (original.account_id !== pairs[i]![0] || original.collection_id !== pairs[i]![1]
        || runs.has(original.migration_id) || Date.parse(original.started_at) > Date.parse(result.archive_created_at)) refuse();
    runs.add(original.migration_id);
  }
}

type OriginalArchiveFence = { complete_sha256: string; original: Extract<VerifiedBatchArchive, { schema: typeof SCOPED_HOSTED_ARCHIVE_SCHEMA }>["scoped_recovery"]["source_fences"][number] };

/** Same exact original data at both sides of provider awaits. No timestamp
 * normalization, newer head adoption or external-I/O settlement assertion. */
export function requireOriginalArchiveSource(archive: OriginalArchiveFence, source: LegacyMigrationDrain, watermark: LegacyNotificationWatermark | null): void {
  const original = archive.original;
  if (source.collection_id !== original.collection_id || source.state !== "migrating" || source.retain_until !== null
      || source.migration_id !== original.migration_id || source.started_at !== original.started_at || source.head !== original.head
      || source.in_flight !== original.in_flight || source.unresolved !== original.unresolved
      || source.applied_unreceipted !== original.applied_unreceipted || watermark !== original.notification_watermark) refuse();
}
