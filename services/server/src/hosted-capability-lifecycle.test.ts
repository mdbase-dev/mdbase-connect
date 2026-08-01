import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import {
  hostedGrantRevocationStatus,
  hostedReplicaRevocationStatus,
  ProviderRevocationWorker,
  queueHostedGrantRevocation,
  queueHostedReplicaRevocation
} from "./hosted-capability-lifecycle.js";

let database: DatabasePool | undefined;
afterEach(async () => database?.end());

describe("hosted capability lifecycle", () => {
  it("revokes locally and durably queues provider cleanup in one transaction", async () => {
    const fixture = await capabilityFixture();
    expect(await hostedGrantRevocationStatus(
      fixture.db,
      fixture.userId,
      fixture.grantId
    )).toBe("active");
    const queued = await queueHostedGrantRevocation(
      fixture.db,
      fixture.userId,
      fixture.grantId,
      "user_request"
    );

    expect(queued).toMatchObject({
      grantId: fixture.grantId,
      replicaId: fixture.replicaId,
      collectionId: fixture.collectionId
    });
    const state = await fixture.db.query(
      `SELECT g.revoked_at AS grant_revoked_at,
              replica.revoked_at AS replica_revoked_at,
              access.revoked_at AS access_revoked_at,
              refresh.revoked_at AS refresh_revoked_at,
              job.state AS job_state, job.reason
       FROM grants g
       JOIN hosted_replicas replica ON replica.id = g.hosted_replica_id
       JOIN access_tokens access ON access.grant_id = g.id
       JOIN refresh_tokens refresh ON refresh.grant_id = g.id
       JOIN provider_revocation_jobs job ON job.grant_id = g.id
       WHERE g.id = $1`,
      [fixture.grantId]
    );
    expect(state.rows[0]).toMatchObject({
      job_state: "pending",
      reason: "user_request"
    });
    expect(state.rows[0].grant_revoked_at).toBeTruthy();
    expect(state.rows[0].replica_revoked_at).toBeTruthy();
    expect(state.rows[0].access_revoked_at).toBeTruthy();
    expect(state.rows[0].refresh_revoked_at).toBeTruthy();
    expect(await hostedGrantRevocationStatus(
      fixture.db,
      fixture.userId,
      fixture.grantId
    )).toBe("revoking");
  });

  it("delivers queued revocation to both provider capability surfaces", async () => {
    const fixture = await capabilityFixture();
    await queueHostedGrantRevocation(
      fixture.db,
      fixture.userId,
      fixture.grantId,
      "test"
    );
    const provider = {
      revokeReplica: vi.fn(async () => undefined),
      revokeNotificationGrant: vi.fn(async () => undefined)
    };
    const worker = new ProviderRevocationWorker(
      fixture.db,
      provider as never
    );

    expect(await worker.drain()).toBe(1);
    expect(provider.revokeReplica).toHaveBeenCalledWith(fixture.replicaId);
    expect(provider.revokeNotificationGrant).toHaveBeenCalledWith(
      fixture.collectionId,
      fixture.grantId
    );
    const job = await fixture.db.query(
      "SELECT state, completed_at FROM provider_revocation_jobs"
    );
    expect(job.rows[0].state).toBe("completed");
    expect(job.rows[0].completed_at).toBeTruthy();
    expect(await hostedGrantRevocationStatus(
      fixture.db,
      fixture.userId,
      fixture.grantId
    )).toBe("revoked");
  });

  it("revokes mirror replicas durably without inventing a notification grant", async () => {
    const fixture = await capabilityFixture();
    const replicaId = randomUUID();
    await fixture.db.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode)
       VALUES ($1, $2, $3, 'Mirror', 'mirror', 'read_write')`,
      [replicaId, fixture.collectionId, fixture.userId]
    );
    const queued = await queueHostedReplicaRevocation(
      fixture.db,
      replicaId,
      fixture.collectionId,
      "user_request"
    );
    expect(queued).toMatchObject({
      replicaId,
      collectionId: fixture.collectionId
    });
    const provider = {
      revokeReplica: vi.fn(async () => undefined),
      revokeNotificationGrant: vi.fn(async () => undefined)
    };

    expect(await new ProviderRevocationWorker(
      fixture.db,
      provider as never
    ).drain()).toBe(1);
    expect(provider.revokeReplica).toHaveBeenCalledWith(replicaId);
    expect(provider.revokeNotificationGrant).not.toHaveBeenCalled();
    const replica = await fixture.db.query(
      "SELECT revoked_at FROM hosted_replicas WHERE id = $1",
      [replicaId]
    );
    const job = await fixture.db.query(
      "SELECT state, grant_id FROM provider_revocation_jobs WHERE id = $1",
      [queued!.jobId]
    );
    expect(replica.rows[0].revoked_at).toBeTruthy();
    expect(await hostedReplicaRevocationStatus(fixture.db, replicaId))
      .toBe("revoked");
    expect(job.rows[0]).toMatchObject({
      state: "completed",
      grant_id: null
    });
  });

  it("cannot revoke another user's grant", async () => {
    const fixture = await capabilityFixture();
    expect(await queueHostedGrantRevocation(
      fixture.db,
      randomUUID(),
      fixture.grantId,
      "test"
    )).toBeNull();
  });

  it("reclaims provider work after a worker loses its lease", async () => {
    const fixture = await capabilityFixture();
    await queueHostedGrantRevocation(
      fixture.db,
      fixture.userId,
      fixture.grantId,
      "test"
    );
    await fixture.db.query(
      `UPDATE provider_revocation_jobs
       SET state = 'sending', available_at = now() - interval '1 second'`
    );
    const provider = {
      revokeReplica: vi.fn(async () => undefined),
      revokeNotificationGrant: vi.fn(async () => undefined)
    };

    expect(await new ProviderRevocationWorker(
      fixture.db,
      provider as never
    ).drain()).toBe(1);
    const job = await fixture.db.query(
      "SELECT state, attempts FROM provider_revocation_jobs"
    );
    expect(job.rows[0]).toMatchObject({ state: "completed", attempts: 1 });
  });

  it("keeps local revocation effective while provider cleanup retries after an outage", async () => {
    const fixture = await capabilityFixture();
    await queueHostedGrantRevocation(
      fixture.db,
      fixture.userId,
      fixture.grantId,
      "provider_outage"
    );
    const provider = {
      revokeReplica: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("provider unavailable"))
        .mockResolvedValue(undefined),
      revokeNotificationGrant: vi.fn(async () => undefined)
    };
    const errors: unknown[] = [];
    const worker = new ProviderRevocationWorker(
      fixture.db,
      provider as never,
      (error) => errors.push(error)
    );

    expect(await worker.drain()).toBe(0);
    const failedAttempt = await fixture.db.query(
      `SELECT job.state, job.attempts, job.last_error,
              grant_row.revoked_at AS grant_revoked_at,
              replica.revoked_at AS replica_revoked_at
       FROM provider_revocation_jobs job
       JOIN grants grant_row ON grant_row.id = job.grant_id
       JOIN hosted_replicas replica ON replica.id = job.replica_id`
    );
    expect(failedAttempt.rows[0]).toMatchObject({
      state: "pending",
      attempts: 1,
      last_error: "provider unavailable"
    });
    expect(failedAttempt.rows[0].grant_revoked_at).toBeTruthy();
    expect(failedAttempt.rows[0].replica_revoked_at).toBeTruthy();
    expect(errors).toHaveLength(1);

    await fixture.db.query(
      "UPDATE provider_revocation_jobs SET available_at = now() - interval '1 second'"
    );
    expect(await worker.drain()).toBe(1);
    expect(provider.revokeReplica).toHaveBeenCalledTimes(2);
    expect(provider.revokeNotificationGrant).toHaveBeenCalledTimes(1);
    const completed = await fixture.db.query(
      "SELECT state, attempts, last_error FROM provider_revocation_jobs"
    );
    expect(completed.rows[0]).toMatchObject({
      state: "completed",
      attempts: 2,
      last_error: null
    });
  });

  it("serializes overlapping drains without delivering a job twice", async () => {
    const fixture = await capabilityFixture();
    await queueHostedGrantRevocation(
      fixture.db,
      fixture.userId,
      fixture.grantId,
      "test"
    );
    const provider = {
      revokeReplica: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
      revokeNotificationGrant: vi.fn(async () => undefined)
    };
    const worker = new ProviderRevocationWorker(
      fixture.db,
      provider as never
    );

    expect(await Promise.all([worker.drain(), worker.drain()]))
      .toEqual([1, 0]);
    expect(provider.revokeReplica).toHaveBeenCalledTimes(1);
    expect(provider.revokeNotificationGrant).toHaveBeenCalledTimes(1);
  });
});

async function capabilityFixture(): Promise<{
  db: DatabasePool;
  userId: string;
  collectionId: string;
  replicaId: string;
  grantId: string;
}> {
  database = await createDatabase("memory");
  const userId = randomUUID();
  const collectionId = randomUUID();
  const replicaId = randomUUID();
  const applicationId = randomUUID();
  const grantId = randomUUID();
  await database.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, 'User')",
    [userId, `${userId}@example.com`]
  );
  await database.query(
    `INSERT INTO hosted_collections (id, user_id, display_name, template)
     VALUES ($1, $2, 'Collection', 'mdbase')`,
    [collectionId, userId]
  );
  await database.query(
    `INSERT INTO hosted_replicas
       (id, collection_id, authorized_user_id, name, purpose, mode)
     VALUES ($1, $2, $3, 'Application', 'application', 'read_only')`,
    [replicaId, collectionId, userId]
  );
  await database.query(
    `INSERT INTO applications
       (id, canonical_identity, name, homepage, redirect_uris)
     VALUES ($1, $2, 'App', 'https://app.example', '[]'::jsonb)`,
    [applicationId, `test:${applicationId}`]
  );
  await database.query(
    `INSERT INTO grants
       (id, user_id, application_id, hosted_collection_id,
        hosted_replica_id, operations)
     VALUES ($1, $2, $3, $4, $5, '["read"]'::jsonb)`,
    [grantId, userId, applicationId, collectionId, replicaId]
  );
  await database.query(
    `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [randomUUID(), randomUUID(), grantId]
  );
  await database.query(
    `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [randomUUID(), randomUUID(), grantId]
  );
  return { db: database, userId, collectionId, replicaId, grantId };
}
