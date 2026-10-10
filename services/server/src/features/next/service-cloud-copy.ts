// One service-device/outbox bootstrap for public NEXT and migration SHADOW
// callers. The caller supplies current-principal authorization; runtime is an
// internal composition choice, never a public request field. No readiness claim.
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { CreateError, enrolOp, inTransaction, lock, SERVICE_ACCOUNT } from "./bootstrap-common.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";
import { requireAccountNotMigrationFrozen } from "./migration-topology.js";
import type { LogServiceClient } from "./log-service-client.js";
import type { NextControlPlaneConfig } from "./policy-keys.js";
import { registerNextCollection, type PolicyEmitter } from "./policy-outbox.js";
import { generateServiceDevice, loadServiceDevice, storeServiceDevice, type ServiceDeviceRecord } from "./service-devices.js";

export interface CloudCopyBootstrapOptions {
  db: DatabasePool; next: NextControlPlaneConfig; emitter: PolicyEmitter;
  log: Pick<LogServiceClient, "controlItemAt" | "head">; fetchImpl?: typeof fetch;
}
const KINDS = ["hosted", "escrow"] as const;

async function notDeleted(client: DatabaseConnection, collection: string): Promise<void> {
  try { await requireCollectionNotDeleted(client, collection); }
  catch (error) {
    if (error instanceof Error && error.message === "collection_deleted") throw new CreateError(409, "collection_deleted");
    throw error;
  }
}

/** False when free, true when this owner's current cloud copy; never adopt another owner. */
export async function existingCloudCopy(client: DatabaseConnection, collection: string, owner: string): Promise<boolean> {
  await notDeleted(client, collection);
  const row = (await client.query<{ owner_user_id: string; sync: string; left: boolean }>(
    "SELECT owner_user_id, sync, left_sync_at IS NOT NULL AS left FROM next_collections WHERE collection_id = $1 FOR UPDATE", [collection]
  )).rows[0];
  if (row && (row.owner_user_id !== owner || row.sync !== "cloud_copy" || row.left)) throw new CreateError(409, "collection_exists");
  if (!row) {
    const other = await client.query("SELECT 1 FROM collections WHERE local_id = $1 AND user_id <> $2 AND removed_at IS NULL", [collection, owner]);
    if (other.rows.length) throw new CreateError(409, "collection_exists");
  }
  return Boolean(row);
}

/** The collection is still this owner's current cloud copy, held through publication. */
export async function currentCloudCopy(client: DatabaseConnection, collection: string, owner: string): Promise<void> {
  await notDeleted(client, collection);
  const current = await client.query(
    "SELECT 1 FROM next_collections WHERE collection_id=$1 AND owner_user_id=$2 AND sync='cloud_copy' AND left_sync_at IS NULL FOR SHARE", [collection, owner]);
  if (!current.rows.length) throw new CreateError(409, "not_current_cloud_copy");
}

/** Each deployment generates its own keys; no collection or principal lock spans the await. */
export function generateCloudCopyServices(options: CloudCopyBootstrapOptions, collection: string) {
  const deployments = options.next.cloudCopyBootstrap;
  if (!deployments) throw new CreateError(503, "not_ready");
  return Promise.all(KINDS.map(kind => generateServiceDevice(deployments[kind], kind, collection, options.fetchImpl)));
}

/** Verify exact appended bytes at the saved position, never just an outbox row/202. */
export async function appendedCloudCopyBatch(options: CloudCopyBootstrapOptions, collection: string,
  batch: { seq: string | number | null; item: Buffer | null; state: string | null } | undefined) {
  const seq = batch?.seq === null || batch?.seq === undefined ? null : Number(batch.seq);
  const external = seq !== null && batch?.state === "appended" ? await options.log.controlItemAt(collection, seq) : null;
  if (seq === null || !batch?.item || !external || !batch.item.equals(Buffer.from(external))) throw new CreateError(503, "not_ready");
  return { seq, item: batch.item };
}
export async function appendedCloudCopyGenesis(options: CloudCopyBootstrapOptions, collection: string) {
  await options.emitter.drainCollection(collection);
  const genesis = (await options.db.query<{ seq: string; item: Buffer; state: string }>(
    "SELECT seq, item, state FROM next_policy_batches WHERE collection_id = $1 AND seq = 1 ORDER BY id LIMIT 1", [collection]
  )).rows[0];
  return appendedCloudCopyBatch(options, collection, genesis);
}
export async function loadCloudCopyRecords(client: DatabaseConnection, collection: string): Promise<ServiceDeviceRecord[]> {
  const records: ServiceDeviceRecord[] = [];
  for (const kind of KINDS) {
    const record = await loadServiceDevice(client, collection, { kind });
    if (!record) throw new CreateError(503, "not_ready");
    records.push(record);
  }
  return records;
}
export function cloudCopyMetadata(options: CloudCopyBootstrapOptions, collection: string, owner: string,
  head: { seq: number; chain: Uint8Array }, genesis: Buffer, records: ServiceDeviceRecord[]) {
  return {
    collection_id: collection, state: "cloud-copy", owner_account: owner,
    log_url: options.next.logService.url, head: { seq: head.seq, chain: Buffer.from(head.chain).toString("hex") },
    root_public_key: Buffer.from(options.next.rootPublicKey).toString("hex"), policy_cert: options.next.policyCert,
    genesis: { seq: 1, item: genesis.toString("hex") }, service_devices: records.map(record => ({
      kind: record.kind, device_id: record.device_id,
      sign_pk: record.sign_pk.toString("hex"), kem_pk: record.kem_pk.toString("hex"), noise_pk: record.noise_pk.toString("hex")
    }))
  };
}

/** Same creator for public service bootstrap and migration; immutable tuple and
 * first committed service identities win. Result contains public facts only:
 * native service activation/keying/source admission remain separate. */
export async function createServiceCloudCopy(options: CloudCopyBootstrapOptions, input: {
  collection: string; owner: string; runtime: "shadow" | "next"; displayName: string;
  current: (client: DatabaseConnection) => Promise<void>;
}) {
  const { collection, owner, runtime, displayName, current } = input;
  const rootKeyId = Buffer.from(options.next.policyCert.root_key_id, "hex");
  const check = async (client: DatabaseConnection) => {
    // Owner/principal first, then collection: do not invert deletion/freeze locks.
    await current(client);
    await lock(client, collection);
    const exists = await existingCloudCopy(client, collection, owner);
    if (exists) {
      const exact = await client.query("SELECT 1 FROM next_collections WHERE collection_id=$1 AND runtime=$2 AND root_key_id=$3", [collection, runtime, rootKeyId]);
      if (!exact.rows.length) throw new CreateError(409, "collection_exists");
    } else if (runtime === "next") {
      try { await requireAccountNotMigrationFrozen(client, owner); }
      catch (error) {
        if (error instanceof RequestValidationError) throw new CreateError(error.statusCode, error.code);
        throw error;
      }
    }
    return exists;
  };
  const exists = await inTransaction(options.db, check);
  if (!exists) {
    const generated = await generateCloudCopyServices(options, collection);
    await inTransaction(options.db, async client => {
      // A concurrent creator's committed keys win; retry reads them rather than
      // replacing them with the generated candidate tuple.
      if (await check(client)) throw new CreateError(503, "not_ready");
      await registerNextCollection(client, { collectionId: collection, ownerUserId: owner, runtime, sync: "cloud_copy", rootKeyId, displayName,
        ops: [{ op: "genesis", owner, root: rootKeyId, state: "cloud-copy" }, { op: "member-set", account: owner, role: "owner" },
          ...generated.map(record => enrolOp(record.device_id, SERVICE_ACCOUNT, record))] });
      for (const record of generated) await storeServiceDevice(client, collection, record);
    });
  }
  // Recheck principal before the emitter's external effects. Public/migration
  // callbacks retain their own session/start/deletion/suspension semantics.
  await inTransaction(options.db, check);
  const genesis = await appendedCloudCopyGenesis(options, collection);
  await inTransaction(options.db, check);
  const head = await options.log.head(collection);
  return inTransaction(options.db, async client => {
    if (!await check(client)) throw new CreateError(409, "not_current_cloud_copy");
    return { ...cloudCopyMetadata(options, collection, owner, head, genesis.item, await loadCloudCopyRecords(client, collection)), first_member: "hosted" };
  });
}
