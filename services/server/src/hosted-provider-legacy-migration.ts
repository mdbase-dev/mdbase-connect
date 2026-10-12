// Legacy collection migration calls on the hosted provider: source read, fence,
// retention after a committed cutover, and native rollback. The transport stays
// in HostedProviderClient; this module only shapes and checks each exchange.
import { z } from "zod";
import { readBoundedJson } from "./platform/bounded-json.js";
import { HostedProviderResponseError, migrationUuid, legacyMigrationDrainSchema, migrationFenceSchema,
  legacyMigrationRollbackRequestSchema, legacyMigrationRollbackReceiptSchema, legacyNotificationWatermarkSchema,
  migrationRetainedSchema, type LegacyMigrationDrain, type LegacyMigrationFence, type LegacyMigrationRollbackRequest,
  type LegacyMigrationRollbackReceipt, type LegacyNotificationWatermark, type LegacyMigrationRetained
} from "./hosted-provider-replies.js";

/** Authenticated provider request with the caller's operation options bound. */
export type LegacyMigrationRequest = (method: string, path: string, body: unknown,
  readReply: (response: Response) => Promise<unknown>, attempts?: 1 | 3) => Promise<unknown>;
export interface LegacyMigrationSource { drain: LegacyMigrationDrain; notificationWatermark: LegacyNotificationWatermark }

const invalid = (message: string) => new HostedProviderResponseError(502, "invalid_provider_response", message);
const smallReply = (response: Response) => readBoundedJson(response, 4096);
const path = (id: string, suffix = "") => `/internal/v1/collections/${id}/legacy-migration${suffix}`;

async function readSource(request: LegacyMigrationRequest, collectionId: string) {
  const id = migrationUuid.parse(collectionId);
  let etag: string | null = null;
  const drain = legacyMigrationDrainSchema.parse(await request("GET", path(id), undefined, response => {
    etag = response.headers.get("etag");
    return smallReply(response);
  }));
  if (drain.collection_id !== id) throw invalid("Migration source identity does not match.");
  return { drain, etag: etag as string | null };
}

export async function legacyMigrationDrain(request: LegacyMigrationRequest, collectionId: string): Promise<LegacyMigrationDrain> {
  return (await readSource(request, collectionId)).drain;
}

/** The drain plus its notification watermark ETag from the same response.
 * A missing or malformed watermark is an invalid reply, never "unchanged". */
export async function legacyMigrationSource(request: LegacyMigrationRequest, collectionId: string): Promise<LegacyMigrationSource> {
  const { drain, etag } = await readSource(request, collectionId);
  const watermark = legacyNotificationWatermarkSchema.safeParse(etag);
  if (!watermark.success) throw invalid("Migration source has no valid notification watermark.");
  return { drain, notificationWatermark: watermark.data };
}

/** Deny-first fence; retries reuse the provider's existing migration identity. */
export async function legacyMigrationFence(request: LegacyMigrationRequest, collectionId: string): Promise<LegacyMigrationFence> {
  const id = migrationUuid.parse(collectionId);
  const result = migrationFenceSchema.parse(await request("PUT", path(id), { state: "migrating" }, smallReply));
  if (result.collection_id !== id) throw invalid("Migration fence identity does not match.");
  return result;
}

/** Move a fenced legacy collection to `migrated`, starting retention. Only for
 * an already committed cutover. Repeating it is a provider no-op that never
 * shortens retention; it refuses an unfenced or undrained source. */
export async function legacyMigrationRetain(request: LegacyMigrationRequest, collectionId: string,
  retainUntil: Date): Promise<LegacyMigrationRetained> {
  const id = migrationUuid.parse(collectionId);
  const requested = retainUntil.toISOString();
  const result = migrationRetainedSchema.parse(await request("PUT", path(id),
    { state: "migrated", retain_until: requested }, smallReply));
  if (result.collection_id !== id || Date.parse(result.retain_until) < Date.parse(requested)) {
    throw invalid("Migration retention does not match.");
  }
  return result;
}

/** Native rollback guards required; a lost response is UNKNOWN, never auto-retried.
 * A receipt lookup uses the ORIGINAL binding; missing/active-only is not success. */
export async function legacyMigrationRollback(request: LegacyMigrationRequest, action: "rollback" | "rollback-receipt",
  collectionId: string, binding: LegacyMigrationRollbackRequest): Promise<LegacyMigrationRollbackReceipt> {
  const id = migrationUuid.parse(collectionId);
  const input = legacyMigrationRollbackRequestSchema.parse(binding);
  const result = legacyMigrationRollbackReceiptSchema.parse(await request("POST", path(id, `/${action}`), input,
    response => readBoundedJson(response, 128 * 1024), 1));
  if (result.collection_id !== id || JSON.stringify(result.binding) !== JSON.stringify(input)) {
    throw invalid("Rollback receipt binding does not match.");
  }
  return result;
}

// Migration replica fronts. Bodies are passed through to the native settlement
// mirror unchanged, so key sets are exact and ids canonical, sorted and unique.
const counter = z.number().refine(value => Number.isSafeInteger(value) && value >= 0);
const sortedReplicaIds = z.array(migrationUuid).max(1000)
  .refine(ids => ids.every((id, i) => i === 0 || ids[i - 1]! < id));
const migrationReplicaListSchema = z.object({ replicas: z.array(z.object({
  id: migrationUuid, head: counter, acknowledged_sequence: counter,
  last_seen_at: z.iso.datetime({ offset: true }).nullable(), token_expires_at: z.iso.datetime({ offset: true })
}).strict()).max(1000).refine(rows => new Set(rows.map(row => row.id)).size === rows.length) }).strict();
const migrationRevokeReplicasSchema = z.object({ revoked: sortedReplicaIds }).strict();
const migrationRestoreReplicasSchema = z.object({ restored: z.array(migrationUuid).max(1000) }).strict();
/** The revocations the provider's CURRENT run owns (fenced, uncut only). */
const migrationRevokedReplicasSchema = z.object({
  collection_id: migrationUuid, migration_id: migrationUuid, revoked: sortedReplicaIds
}).strict();
/** Pre-cutover `migrating` -> `active`: the run ends, nothing restored here. */
const migrationUnfencedSchema = z.object({
  collection_id: migrationUuid, state: z.literal("active"), migration_id: z.null(),
  started_at: z.null(), retain_until: z.null(), restored: z.array(migrationUuid).max(0)
}).strict();

const replyBounded = (response: Response) => readBoundedJson(response, 256 * 1024);
const replicaIds = (ids: string[]) => {
  const sorted = ids.map(id => migrationUuid.parse(id)).sort();
  if (sorted.some((id, i) => i > 0 && id === sorted[i - 1])) throw new TypeError("Replica ids must be unique.");
  return sorted;
};

/** Live mirror replicas, the exact provider body (`GET …/replicas`). */
export async function legacyMigrationReplicas(request: LegacyMigrationRequest, collectionId: string): Promise<z.infer<typeof migrationReplicaListSchema>> {
  const id = migrationUuid.parse(collectionId);
  return migrationReplicaListSchema.parse(await request("GET", `/internal/v1/collections/${id}/replicas`, undefined, replyBounded));
}

/** H8: the provider revokes live listed replicas for its current run and
 * answers the listed ids that run owns; a retry answers the same set. */
export async function legacyMigrationRevokeReplicas(request: LegacyMigrationRequest, collectionId: string,
  ids: string[]): Promise<{ revoked: string[] }> {
  const id = migrationUuid.parse(collectionId), requested = replicaIds(ids);
  const result = migrationRevokeReplicasSchema.parse(await request("POST", path(id, "/revoke-replicas"), { replica_ids: requested }, replyBounded));
  if (result.revoked.some(replica => !requested.includes(replica))) throw invalid("Revoked replicas exceed the request.");
  return result;
}

/** Rollback of H8 for listed replicas still owned by the current run. One
 * attempt: a repeated restore answers a smaller set, so a lost reply is UNKNOWN. */
export async function legacyMigrationRestoreReplicas(request: LegacyMigrationRequest, collectionId: string,
  ids: string[]): Promise<{ restored: string[] }> {
  const id = migrationUuid.parse(collectionId), requested = replicaIds(ids);
  const result = migrationRestoreReplicasSchema.parse(await request("POST", path(id, "/restore-replicas"), { replica_ids: requested }, replyBounded, 1));
  if (result.restored.some(replica => !requested.includes(replica))) throw invalid("Restored replicas exceed the request.");
  return { restored: [...result.restored].sort() };
}

export async function legacyMigrationRevokedReplicas(request: LegacyMigrationRequest, collectionId: string): Promise<z.infer<typeof migrationRevokedReplicasSchema>> {
  const id = migrationUuid.parse(collectionId);
  const result = migrationRevokedReplicasSchema.parse(await request("GET", path(id, "/revoked-replicas"), undefined, replyBounded));
  if (result.collection_id !== id) throw invalid("Migration revocation identity does not match.");
  return result;
}

/** Pre-cutover unfence (`migrating` -> `active`). One attempt; the caller must
 * first establish that the run owns no revocation, which `active` cannot restore. */
export async function legacyMigrationUnfence(request: LegacyMigrationRequest, collectionId: string): Promise<z.infer<typeof migrationUnfencedSchema>> {
  const id = migrationUuid.parse(collectionId);
  const result = migrationUnfencedSchema.parse(await request("PUT", path(id), { state: "active" }, smallReply, 1));
  if (result.collection_id !== id) throw invalid("Migration unfence identity does not match.");
  return result;
}
