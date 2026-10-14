import { z } from "zod";
import type { DatabaseQueryable } from "../../database-types.js";

/** Named scoped profile: two real encrypted inventory/provenance artifacts,
 * never three database dumps, hosted objects, or a local-folder backup. */
export const ZERO_HOSTED_ARCHIVE_SCHEMA = "mdbase-recovery-set/zero-hosted-v1";
export const ZERO_HOSTED_ARCHIVE_PAYLOAD_COUNT = "2";

export function isCompleteZeroHostedInventory(inventory: readonly (readonly [string, readonly string[]])[]): boolean {
  return inventory.length > 0 && inventory.length <= 850 && inventory.every(([, held]) => held.length === 0);
}

/** Caller retains the existing cohort lock; acquire no account/child locks after
 * it. Frozen topology serializes ordinary ownership changes against this read. */
export async function isCurrentZeroHostedCohort(client: DatabaseQueryable, name: string): Promise<boolean> {
  const row = (await client.query<{ empty: boolean }>(
    `SELECT (SELECT count(*) FROM next_migration_cohort_members WHERE cohort=$1) BETWEEN 1 AND 850
       AND NOT EXISTS (SELECT 1 FROM next_migration_cohort_members m
         JOIN hosted_collections h ON h.user_id=m.account_id AND h.authority_state<>'transferred'
         WHERE m.cohort=$1) AS empty`, [name]
  )).rows[0];
  return row?.empty === true;
}

// Canonical scalars must consume the entire string without normalization.
export const COHORT_NAME = /^[a-z0-9][a-z0-9-]{0,62}(?![\s\S])/;
// LAB is a separate exact schema with a mandatory legacy-archive prefix.
// Existing v4 locations retain their unchanged staging/production contract.
export const ARCHIVE_PREFIX = /^(?:legacy-archive\/)?(staging|production|lab)\/20[0-9]{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])\/[a-z0-9][a-z0-9-]{0,79}(?![\s\S])/;
export const HEX64 = /^[0-9a-f]{64}(?![\s\S])/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/;

export const decimal = (max: bigint, positive = false) => z.string().max(20).refine((v) =>
  /^(0|[1-9][0-9]*)(?![\s\S])/.test(v) && BigInt(v) <= max && (!positive || BigInt(v) > 0n));
export const millisecondTime = z.string().length(24).refine((v) => {
  if (!UTC_MILLISECONDS.test(v) || v.startsWith("0000-")) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
});
export const archiveBindingSchema = z.object({
  batch_id: z.string().regex(COHORT_NAME),
  membership_revision: decimal(9_223_372_036_854_775_807n, true),
  membership_digest: z.string().regex(HEX64),
  membership_changed_at: millisecondTime
}).strict();
const v4VerifiedArchiveSchema = z.object({
  schema: z.literal("mdbase-recovery-set/v4"),
  environment: z.enum(["production", "staging"]),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](?![\s\S])/),
  prefix: z.string().max(128).regex(ARCHIVE_PREFIX),
  backup_id: z.string().max(80).regex(/^[a-z0-9][a-z0-9-]{0,79}(?![\s\S])/),
  complete_sha256: z.string().regex(HEX64),
  manifest_sha256: z.string().regex(HEX64),
  source_commit: z.string().regex(/^[0-9a-f]{40}(?![\s\S])/),
  migration_batch: archiveBindingSchema,
  archive_created_at: millisecondTime,
  archive_completed_at: millisecondTime,
  retention: z.object({
    mode: z.literal("GOVERNANCE"), days: z.literal(116), retain_until: millisecondTime,
    inventory_digest: z.string().regex(HEX64), count: decimal(18_446_744_073_709_551_615n, true)
  }).strict()
}).strict();
// Opaque service IDs only: fixed private LAB infrastructure mapping, image
// signatures/attestations and live currentness are the ONE verifier's boundary.
// Structural decoding cannot establish those facts or open source-exclusion.
const labRuntimeComponentSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}(?![\s\S])/),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}(?![\s\S])/),
  service_id: z.string().max(84).regex(/^srv-[a-z0-9]{1,80}(?![\s\S])/)
}).strict();
const labVerifiedArchiveSchema = v4VerifiedArchiveSchema.extend({
  schema: z.literal("mdbase-recovery-set/lab-cohort-v1"), environment: z.literal("lab"),
  prefix: z.string().max(128).regex(/^legacy-archive\/lab\/20[0-9]{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])\/[a-z0-9][a-z0-9-]{0,79}(?![\s\S])/),
  // source_commit is Ops capture/signing source, never a guessed common runtime.
  runtime_provenance: z.object({ connect: labRuntimeComponentSchema, hosted_provider: labRuntimeComponentSchema,
    relay: labRuntimeComponentSchema, mcp: labRuntimeComponentSchema }).strict()
}).strict();
// Only the scoped inventory/provenance artifacts are archived. Production
// capture stays closed; this is not permission to omit any hosted payload.
const zeroHostedVerifiedArchiveSchema = v4VerifiedArchiveSchema.extend({
  schema: z.literal(ZERO_HOSTED_ARCHIVE_SCHEMA), environment: z.enum(["lab", "staging"]),
  prefix: z.string().max(128).regex(/^legacy-archive\/(lab|staging)\/20[0-9]{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])\/[a-z0-9][a-z0-9-]{0,79}(?![\s\S])/),
  retention: v4VerifiedArchiveSchema.shape.retention.extend({ count: z.literal(ZERO_HOSTED_ARCHIVE_PAYLOAD_COUNT) }).strict()
}).strict();
export const verifiedArchiveSchema = z.union([v4VerifiedArchiveSchema, labVerifiedArchiveSchema, zeroHostedVerifiedArchiveSchema]);
export type ArchiveBinding = z.infer<typeof archiveBindingSchema>;
export type VerifiedBatchArchive = z.infer<typeof verifiedArchiveSchema>;

