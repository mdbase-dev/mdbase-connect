// Provider reply decoding shared by the transport and migration consumers.
// Keep exact authority-sensitive source/fence facts separate from HTTP success.
import { z } from "zod";

export class HostedProviderResponseError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export class HostedProviderUnavailableError extends Error {
  constructor(public readonly cause: unknown) { super("The hosted storage provider is temporarily unavailable."); }
}

export async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
export function asProviderError(value: unknown): { code: string; message: string } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  return {
    code: typeof error.code === "string" ? error.code : "hosted_provider_error",
    message: typeof error.message === "string" ? error.message : "The hosted storage provider rejected the request."
  };
}

export const migrationUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/u)
  .refine(value => value !== "00000000-0000-0000-0000-000000000000");
const migrationCounter = z.number().refine(value => Number.isSafeInteger(value) && value >= 0);
export const legacyMigrationDrainSchema = z.object({
  collection_id: migrationUuid, state: z.string().min(1).max(64), head: migrationCounter,
  started_at: z.iso.datetime({ offset: true }).nullable(), retain_until: z.iso.datetime({ offset: true }).nullable(),
  in_flight: migrationCounter, unresolved: migrationCounter, applied_unreceipted: migrationCounter,
  migration_id: migrationUuid.nullable().optional()
}).strict();
export type LegacyMigrationDrain = z.infer<typeof legacyMigrationDrainSchema>;
export const migrationFenceSchema = z.object({
  collection_id: migrationUuid, state: z.literal("migrating"), migration_id: migrationUuid,
  started_at: z.iso.datetime({ offset: true }), retain_until: z.iso.datetime({ offset: true }).nullable(),
  restored: z.array(migrationUuid).max(0)
}).strict();
export type LegacyMigrationFence = z.infer<typeof migrationFenceSchema>;

// Metadata correlation only, not native rollback/currentness authority. Refuse
// counters outside the JS safe-integer range rather than rounding native u64s.
const rollbackReplicaIds = z.array(migrationUuid).max(1000)
  .refine(ids => new Set(ids).size === ids.length)
  .transform(ids => ids.sort());
export const legacyMigrationRollbackRequestSchema = z.object({
  owner_account_id: migrationUuid, provider_migration_id: migrationUuid,
  authority_epoch: migrationCounter.refine(value => value > 0), fixed_head: migrationCounter,
  driver_id: migrationUuid, action_id: migrationUuid, replica_ids: rollbackReplicaIds
}).strict();
export type LegacyMigrationRollbackRequest = z.infer<typeof legacyMigrationRollbackRequestSchema>;
export const legacyMigrationRollbackReceiptSchema = z.object({
  collection_id: migrationUuid, binding: legacyMigrationRollbackRequestSchema,
  restored_ids: rollbackReplicaIds, recorded_at: z.iso.datetime({ offset: true }).max(64)
}).strict().refine(receipt => receipt.restored_ids.every(id => receipt.binding.replica_ids.includes(id)));
export type LegacyMigrationRollbackReceipt = z.infer<typeof legacyMigrationRollbackReceiptSchema>;
