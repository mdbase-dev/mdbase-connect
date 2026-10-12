// Legacy collection migration calls on the hosted provider: source read, fence,
// retention after a committed cutover, and native rollback. The transport stays
// in HostedProviderClient; this module only shapes and checks each exchange.
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
