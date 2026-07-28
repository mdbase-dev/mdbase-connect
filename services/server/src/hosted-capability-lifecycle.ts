import { randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "./db.js";
import type { HostedProviderClient } from "./hosted-provider.js";

interface RevocationJob {
  id: string;
  replica_id: string;
  grant_id: string | null;
  collection_id: string;
  attempts: number;
}

export interface QueuedGrantRevocation {
  grantId: string;
  replicaId: string;
  collectionId: string;
  jobId: string;
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
    let completed = 0;
    while (completed < limit) {
      const job = await claimRevocationJob(this.db);
      if (!job) break;
      try {
        await this.provider.revokeReplica(job.replica_id);
        if (job.grant_id) {
          await this.provider.revokeNotificationGrant(
            job.collection_id,
            job.grant_id
          );
        }
        await this.db.query(
          `UPDATE provider_revocation_jobs
           SET state = 'completed', completed_at = now(), last_error = NULL
           WHERE id = $1`,
          [job.id]
        );
        completed += 1;
      } catch (error) {
        await rescheduleRevocationJob(this.db, job, error);
        this.onError(error);
        break;
      }
    }
    return completed;
  }
}

async function claimRevocationJob(
  db: DatabasePool
): Promise<RevocationJob | null> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const found = await connection.query<RevocationJob>(
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
           available_at = now() + interval '30 seconds'
       WHERE id = $1`,
      [job.id]
    );
    await connection.query("COMMIT");
    return job;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function rescheduleRevocationJob(
  db: DatabaseQueryable,
  job: RevocationJob,
  error: unknown
): Promise<void> {
  const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts + 1, 8));
  await db.query(
    `UPDATE provider_revocation_jobs
     SET state = 'pending',
         available_at = now() + ($2 * interval '1 second'),
         last_error = $3
     WHERE id = $1`,
    [
      job.id,
      delaySeconds,
      error instanceof Error ? error.message.slice(0, 2_000) : String(error)
    ]
  );
}
