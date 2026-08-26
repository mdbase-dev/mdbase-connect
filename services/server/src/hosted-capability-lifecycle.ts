import { randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "./db.js";
import { audit } from "./platform/audit-events.js";
import {
  HostedProviderResponseError,
  type HostedProviderClient
} from "./hosted-provider.js";

interface RevocationJob {
  kind: "revoke_replica";
  id: string;
  replica_id: string;
  grant_id: string | null;
  collection_id: string;
  attempts: number;
}

interface CollectionDeletionJob {
  kind: "delete_collection";
  id: string;
  collection_id: string;
  attempts: number;
}

type ProviderCleanupJob = RevocationJob | CollectionDeletionJob;

export interface AccountProviderCleanup {
  hostedCollections: number;
  crossAccountReplicas: number;
}

export interface QueuedGrantRevocation {
  grantId: string;
  replicaId: string;
  collectionId: string;
  jobId: string;
}

export interface QueuedReplicaRevocation {
  replicaId: string;
  collectionId: string;
  jobId: string;
}

export type HostedRevocationStatus = "active" | "revoking" | "revoked";

export async function hostedGrantRevocationStatus(
  db: DatabaseQueryable,
  userId: string,
  grantId: string
): Promise<HostedRevocationStatus | null> {
  const result = await db.query<{
    revoked_at: string | null;
    provider_pending: boolean;
  }>(
    `SELECT g.revoked_at,
            g.id IN (
              SELECT job.grant_id FROM provider_revocation_jobs job
              WHERE job.grant_id IS NOT NULL AND job.completed_at IS NULL
            ) AS provider_pending
     FROM grants g
     WHERE g.id = $1 AND g.user_id = $2 AND g.activated_at IS NOT NULL`,
    [grantId, userId]
  );
  const grant = result.rows[0];
  if (!grant) return null;
  if (!grant.revoked_at) return "active";
  return grant.provider_pending ? "revoking" : "revoked";
}

export async function hostedReplicaRevocationStatus(
  db: DatabaseQueryable,
  replicaId: string
): Promise<HostedRevocationStatus | null> {
  const result = await db.query<{
    revoked_at: string | null;
    provider_pending: boolean;
  }>(
    `SELECT replica.revoked_at,
            replica.id IN (
              SELECT job.replica_id FROM provider_revocation_jobs job
              WHERE job.completed_at IS NULL
            ) AS provider_pending
     FROM hosted_replicas replica
     WHERE replica.id = $1`,
    [replicaId]
  );
  const replica = result.rows[0];
  if (!replica) return null;
  if (!replica.revoked_at) return "active";
  return replica.provider_pending ? "revoking" : "revoked";
}

/**
 * Atomically makes a hosted capability unusable in Connect and records the
 * provider-side cleanup as durable work. Provider availability can no longer
 * prevent local revocation.
 */
export async function queueHostedGrantRevocation(
  db: DatabasePool,
  userId: string,
  grantId: string,
  reason: string
): Promise<QueuedGrantRevocation | null> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const active = await connection.query<{
      hosted_collection_id: string | null;
      hosted_replica_id: string | null;
    }>(
      `SELECT hosted_collection_id, hosted_replica_id
       FROM grants
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       FOR UPDATE`,
      [grantId, userId]
    );
    const grant = active.rows[0];
    if (
      !grant
      || !grant.hosted_collection_id
      || !grant.hosted_replica_id
    ) {
      await connection.query("ROLLBACK");
      return null;
    }
    const jobId = randomUUID();
    await connection.query(
      `UPDATE hosted_replicas
       SET revoked_at = COALESCE(revoked_at, now()), token_hash = NULL
       WHERE id = $1`,
      [grant.hosted_replica_id]
    );
    await connection.query(
      "UPDATE grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1",
      [grantId]
    );
    await connection.query(
      `UPDATE access_tokens
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE grant_id = $1`,
      [grantId]
    );
    await connection.query(
      `UPDATE refresh_tokens
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE grant_id = $1`,
      [grantId]
    );
    await connection.query(
      `INSERT INTO provider_revocation_jobs
         (id, replica_id, grant_id, collection_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        jobId,
        grant.hosted_replica_id,
        grantId,
        grant.hosted_collection_id,
        reason
      ]
    );
    await connection.query("COMMIT");
    return {
      grantId,
      replicaId: grant.hosted_replica_id,
      collectionId: grant.hosted_collection_id,
      jobId
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Revokes a non-application replica locally before attempting provider
 * cleanup. The caller owns collection authorization; this function owns the
 * atomic capability and cleanup-job transition.
 */
export async function queueHostedReplicaRevocation(
  db: DatabasePool,
  replicaId: string,
  collectionId: string,
  reason: string
): Promise<QueuedReplicaRevocation | null> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const active = await connection.query<{ id: string }>(
      `SELECT id FROM hosted_replicas
       WHERE id = $1 AND collection_id = $2 AND revoked_at IS NULL
       FOR UPDATE`,
      [replicaId, collectionId]
    );
    if (!active.rows[0]) {
      await connection.query("ROLLBACK");
      return null;
    }
    const jobId = randomUUID();
    await connection.query(
      `UPDATE hosted_replicas
       SET revoked_at = now(), token_hash = NULL
       WHERE id = $1`,
      [replicaId]
    );
    await connection.query(
      "DELETE FROM mirror_pairing_requests WHERE replica_id = $1",
      [replicaId]
    );
    await connection.query(
      `INSERT INTO provider_revocation_jobs
         (id, replica_id, grant_id, collection_id, reason)
       VALUES ($1, $2, NULL, $3, $4)`,
      [jobId, replicaId, collectionId, reason]
    );
    await connection.query("COMMIT");
    return { replicaId, collectionId, jobId };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export interface HostedCollectionQuarantineResult {
  changed: boolean;
  grantsRevoked: number;
  replicasRevoked: number;
}

/**
 * Fails a hosted collection closed only after the provider has returned the
 * exact typed missing-collection response. The control row remains available
 * for operator investigation, but every local capability becomes unusable.
 */
export async function quarantineMissingHostedCollection(
  db: DatabasePool,
  collectionId: string
): Promise<HostedCollectionQuarantineResult | null> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const collection = await connection.query<{
      user_id: string;
      quarantined_at: string | Date | null;
    }>(
      `SELECT user_id, quarantined_at FROM hosted_collections
       WHERE id = $1
       FOR UPDATE`,
      [collectionId]
    );
    const row = collection.rows[0];
    if (!row) {
      await connection.query("ROLLBACK");
      return null;
    }
    if (row.quarantined_at !== null) {
      await connection.query("COMMIT");
      return { changed: false, grantsRevoked: 0, replicasRevoked: 0 };
    }
    const grants = await connection.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM grants
       WHERE hosted_collection_id = $1 AND revoked_at IS NULL`,
      [collectionId]
    );
    const replicas = await connection.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM hosted_replicas
       WHERE collection_id = $1 AND revoked_at IS NULL`,
      [collectionId]
    );
    await connection.query(
      `UPDATE hosted_collections
       SET quarantined_at = now(), quarantine_reason = 'provider_collection_missing'
       WHERE id = $1`,
      [collectionId]
    );
    await connection.query(
      `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
       WHERE hosted_collection_id = $1`,
      [collectionId]
    );
    await connection.query(
      `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE grant_id IN (
         SELECT id FROM grants WHERE hosted_collection_id = $1
       )`,
      [collectionId]
    );
    await connection.query(
      `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE grant_id IN (
         SELECT id FROM grants WHERE hosted_collection_id = $1
       )`,
      [collectionId]
    );
    await connection.query(
      `UPDATE hosted_replicas
       SET revoked_at = COALESCE(revoked_at, now()), token_hash = NULL
       WHERE collection_id = $1`,
      [collectionId]
    );
    await connection.query(
      `DELETE FROM mirror_pairing_requests
       WHERE replica_id IN (
         SELECT id FROM hosted_replicas WHERE collection_id = $1
       )`,
      [collectionId]
    );
    await connection.query(
      `UPDATE provider_revocation_jobs
       SET state = 'completed', completed_at = COALESCE(completed_at, now()),
           last_error = NULL
       WHERE collection_id = $1 AND completed_at IS NULL`,
      [collectionId]
    );
    await connection.query(
      `UPDATE provider_collection_deletion_jobs
       SET state = 'completed', completed_at = COALESCE(completed_at, now()),
           last_error = NULL
       WHERE collection_id = $1 AND completed_at IS NULL`,
      [collectionId]
    );
    const result = {
      changed: true,
      grantsRevoked: Number(grants.rows[0]?.count ?? 0),
      replicasRevoked: Number(replicas.rows[0]?.count ?? 0)
    };
    await audit(
      connection,
      row.user_id,
      "hosted_collection.quarantined_missing",
      collectionId,
      {
        reason: "provider_collection_missing",
        grants_revoked: result.grantsRevoked,
        replicas_revoked: result.replicasRevoked
      }
    );
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Makes every provider capability owned by an account unusable in the same
 * transaction that deletes the account, and records idempotent provider
 * cleanup for delivery after commit.
 */
export async function queueAccountProviderCleanup(
  db: DatabaseQueryable,
  userId: string
): Promise<AccountProviderCleanup> {
  const ownedCollections = await db.query<{
    id: string;
    authority_state: string;
    quarantined_at: string | Date | null;
  }>(
    `SELECT id, authority_state, quarantined_at FROM hosted_collections
     WHERE user_id = $1 ORDER BY id FOR UPDATE`,
    [userId]
  );
  const collections = ownedCollections.rows.filter(
    ({ authority_state, quarantined_at }) =>
      authority_state !== "transferred" && quarantined_at === null
  );
  const authorizedReplicas = await db.query<{
    id: string;
    collection_id: string;
    revoked_at: string | Date | null;
  }>(
    `SELECT id, collection_id, revoked_at
     FROM hosted_replicas
     WHERE authorized_user_id = $1
     ORDER BY id
     FOR UPDATE`,
    [userId]
  );
  const ownedCollectionIds = new Set(ownedCollections.rows.map(({ id }) => id));
  const crossAccountReplicas = authorizedReplicas.rows.filter(
    (replica) => !ownedCollectionIds.has(replica.collection_id)
  );

  let activeCrossAccountReplicas = 0;
  for (const replica of crossAccountReplicas) {
    const grant = replica.revoked_at === null
      ? await db.query<{ id: string }>(
          `SELECT id FROM grants
           WHERE hosted_replica_id = $1 AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [replica.id]
        )
      : { rows: [] };
    await db.query(
      `UPDATE hosted_replicas
       SET revoked_at = COALESCE(revoked_at, now()), token_hash = NULL,
           authorized_user_id = NULL
       WHERE id = $1`,
      [replica.id]
    );
    await db.query(
      "DELETE FROM mirror_pairing_requests WHERE replica_id = $1",
      [replica.id]
    );
    if (replica.revoked_at !== null) continue;
    activeCrossAccountReplicas += 1;
    await db.query(
      `INSERT INTO provider_revocation_jobs
         (id, replica_id, grant_id, collection_id, reason)
       VALUES ($1, $2, $3, $4, 'account_deletion')
       ON CONFLICT DO NOTHING`,
      [randomUUID(), replica.id, grant.rows[0]?.id ?? null, replica.collection_id]
    );
  }

  for (const collection of collections) {
    await db.query(
      `INSERT INTO provider_collection_deletion_jobs
         (id, collection_id, reason)
       VALUES ($1, $2, 'account_deletion')
       ON CONFLICT DO NOTHING`,
      [randomUUID(), collection.id]
    );
  }

  return {
    hostedCollections: collections.length,
    crossAccountReplicas: activeCrossAccountReplicas
  };
}

export class ProviderRevocationWorker {
  private timer: NodeJS.Timeout | undefined;
  private drainInFlight: Promise<number> | undefined;

  constructor(
    private readonly db: DatabasePool,
    private readonly provider: HostedProviderClient,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly pollIntervalMs = 5_000
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drain().catch(this.onError);
    }, this.pollIntervalMs);
    this.timer.unref();
    void this.drain().catch(this.onError);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.drainInFlight;
  }

  async drain(limit = 25): Promise<number> {
    while (this.drainInFlight) {
      await this.drainInFlight;
    }
    const execution = this.drainAvailable(limit);
    this.drainInFlight = execution;
    let completed = 0;
    try {
      completed = await execution;
      return completed;
    } finally {
      if (this.drainInFlight === execution) {
        this.drainInFlight = undefined;
      }
    }
  }

  private async drainAvailable(limit: number): Promise<number> {
    let attempted = 0;
    let completed = 0;
    while (attempted < limit) {
      const job = await claimProviderCleanupJob(this.db);
      if (!job) break;
      attempted += 1;
      try {
        if (job.kind === "delete_collection") {
          await this.provider.deleteCollection(job.collection_id);
        } else {
          await this.provider.revokeReplica(job.replica_id);
          if (job.grant_id) {
            await this.provider.revokeNotificationGrant(
              job.collection_id,
              job.grant_id
            );
          }
        }
        await completeProviderCleanupJob(this.db, job);
        completed += 1;
      } catch (error) {
        if (isAlreadyMissingProviderResource(error)) {
          await completeProviderCleanupJob(this.db, job);
          completed += 1;
          continue;
        }
        await rescheduleProviderCleanupJob(this.db, job, error);
        this.onError(error);
      }
    }
    return completed;
  }
}

async function claimProviderCleanupJob(
  db: DatabasePool
): Promise<ProviderCleanupJob | null> {
  return await claimRevocationJob(db) ?? await claimCollectionDeletionJob(db);
}

async function claimRevocationJob(
  db: DatabasePool
): Promise<RevocationJob | null> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const found = await connection.query<Omit<RevocationJob, "kind">>(
      `SELECT id, replica_id, grant_id, collection_id, attempts
       FROM provider_revocation_jobs
       WHERE completed_at IS NULL AND state IN ('pending', 'sending')
         AND available_at <= now()
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE`
    );
    const job = found.rows[0];
    if (!job) {
      await connection.query("COMMIT");
      return null;
    }
    await connection.query(
      `UPDATE provider_revocation_jobs
       SET state = 'sending', attempts = attempts + 1,
           available_at = now() + interval '60 seconds'
       WHERE id = $1`,
      [job.id]
    );
    await connection.query("COMMIT");
    return { kind: "revoke_replica", ...job };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function claimCollectionDeletionJob(
  db: DatabasePool
): Promise<CollectionDeletionJob | null> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const found = await connection.query<Omit<CollectionDeletionJob, "kind">>(
      `SELECT id, collection_id, attempts
       FROM provider_collection_deletion_jobs
       WHERE completed_at IS NULL AND state IN ('pending', 'sending')
         AND available_at <= now()
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE`
    );
    const job = found.rows[0];
    if (!job) {
      await connection.query("COMMIT");
      return null;
    }
    await connection.query(
      `UPDATE provider_collection_deletion_jobs
       SET state = 'sending', attempts = attempts + 1,
           available_at = now() + interval '60 seconds'
       WHERE id = $1`,
      [job.id]
    );
    await connection.query("COMMIT");
    return { kind: "delete_collection", ...job };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function completeProviderCleanupJob(
  db: DatabaseQueryable,
  job: ProviderCleanupJob
): Promise<void> {
  if (job.kind === "delete_collection") {
    await db.query(
      `UPDATE provider_collection_deletion_jobs
       SET state = 'completed', completed_at = now(), last_error = NULL
       WHERE id = $1`,
      [job.id]
    );
    return;
  }
  await db.query(
    `UPDATE provider_revocation_jobs
     SET state = 'completed', completed_at = now(), last_error = NULL
     WHERE id = $1`,
    [job.id]
  );
}

function isAlreadyMissingProviderResource(error: unknown): boolean {
  return error instanceof HostedProviderResponseError
    && error.status === 404
    && ["hosted_collection_not_found", "replica_not_found"].includes(error.code);
}

async function rescheduleProviderCleanupJob(
  db: DatabaseQueryable,
  job: ProviderCleanupJob,
  error: unknown
): Promise<void> {
  const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts + 1, 8));
  const values = [
    job.id,
    new Date(Date.now() + delaySeconds * 1_000),
    error instanceof Error ? error.message.slice(0, 2_000) : String(error)
  ];
  if (job.kind === "delete_collection") {
    await db.query(
      `UPDATE provider_collection_deletion_jobs
       SET state = 'pending', available_at = $2, last_error = $3
       WHERE id = $1`,
      values
    );
    return;
  }
  await db.query(
    `UPDATE provider_revocation_jobs
     SET state = 'pending', available_at = $2, last_error = $3
     WHERE id = $1`,
    values
  );
}
