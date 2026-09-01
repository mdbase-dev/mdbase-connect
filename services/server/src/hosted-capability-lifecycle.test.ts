import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import { HostedProviderResponseError } from "./hosted-provider.js";
import { retireLegacyContractScopedGrants } from "./legacy-backfills.js";
import {
  hostedGrantRevocationStatus,
  hostedReplicaRevocationStatus,
  ProviderRevocationWorker,
  quarantineMissingHostedCollection,
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

  it("quarantines a confirmed missing collection and every local capability atomically", async () => {
    const fixture = await capabilityFixture();
    const applicationId = randomUUID();
    const replicaId = randomUUID();
    const grantId = randomUUID();
    await fixture.db.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, $2, 'Second app', 'https://second.example', '[]'::jsonb)`,
      [applicationId, `test:${applicationId}`]
    );
    await fixture.db.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode)
       VALUES ($1, $2, $3, 'Second application', 'application', 'read_only')`,
      [replicaId, fixture.collectionId, fixture.userId]
    );
    await fixture.db.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id,
          hosted_replica_id, operations)
       VALUES ($1, $2, $3, $4, $5, '["read"]'::jsonb)`,
      [grantId, fixture.userId, applicationId, fixture.collectionId, replicaId]
    );

    expect(await quarantineMissingHostedCollection(
      fixture.db,
      fixture.collectionId
    )).toEqual({ changed: true, grantsRevoked: 2, replicasRevoked: 2 });
    const collection = await fixture.db.query(
      `SELECT quarantine_reason, quarantined_at
       FROM hosted_collections WHERE id = $1`,
      [fixture.collectionId]
    );
    expect(collection.rows[0]).toEqual({
      quarantine_reason: "provider_collection_missing",
      quarantined_at: expect.any(Date)
    });
    const grants = await fixture.db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM grants WHERE hosted_collection_id = $1",
      [fixture.collectionId]
    );
    expect(grants.rows).toHaveLength(2);
    expect(grants.rows.every(({ revoked_at }) => revoked_at !== null)).toBe(true);
    const replicas = await fixture.db.query<{
      revoked_at: Date | null;
      token_hash: string | null;
    }>(
      "SELECT revoked_at, token_hash FROM hosted_replicas WHERE collection_id = $1",
      [fixture.collectionId]
    );
    expect(replicas.rows.every(({ revoked_at, token_hash }) =>
      revoked_at !== null && token_hash === null
    )).toBe(true);
    expect((await fixture.db.query(
      `SELECT id FROM access_tokens WHERE revoked_at IS NULL
       UNION ALL SELECT id FROM refresh_tokens WHERE revoked_at IS NULL`
    )).rows).toEqual([]);
    expect((await fixture.db.query(
      `SELECT id FROM audit_events
       WHERE event_type = 'hosted_collection.quarantined_missing'`
    )).rows).toHaveLength(1);
    expect(await quarantineMissingHostedCollection(
      fixture.db,
      fixture.collectionId
    )).toEqual({ changed: false, grantsRevoked: 0, replicasRevoked: 0 });
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

  it("retires legacy scoped replicas and their notification authority", async () => {
    const fixture = await capabilityFixture();
    await fixture.db.query(
      `UPDATE grants
       SET scope = '{"access":"contract","contracts":[]}'::jsonb
       WHERE id = $1`,
      [fixture.grantId]
    );

    expect(await retireLegacyContractScopedGrants(fixture.db)).toBe(1);
    const provider = {
      revokeReplica: vi.fn(async () => undefined),
      revokeNotificationGrant: vi.fn(async () => undefined)
    };
    const worker = new ProviderRevocationWorker(fixture.db, provider as never);

    expect(await worker.drain()).toBe(1);
    expect(provider.revokeReplica).toHaveBeenCalledWith(fixture.replicaId);
    expect(provider.revokeNotificationGrant).toHaveBeenCalledWith(
      fixture.collectionId,
      fixture.grantId
    );
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

  it("continues unrelated cleanup after one provider job fails", async () => {
    const fixture = await capabilityFixture();
    await queueHostedGrantRevocation(
      fixture.db,
      fixture.userId,
      fixture.grantId,
      "provider_outage"
    );
    await fixture.db.query(
      `UPDATE provider_revocation_jobs
       SET created_at = now() - interval '1 minute'
       WHERE grant_id = $1`,
      [fixture.grantId]
    );
    const secondReplicaId = randomUUID();
    await fixture.db.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, authorized_user_id, name, purpose, mode)
       VALUES ($1, $2, $3, 'Second mirror', 'mirror', 'read_only')`,
      [secondReplicaId, fixture.collectionId, fixture.userId]
    );
    await queueHostedReplicaRevocation(
      fixture.db,
      secondReplicaId,
      fixture.collectionId,
      "user_request"
    );
    const provider = {
      revokeReplica: vi.fn(async (replicaId: string) => {
        if (replicaId === fixture.replicaId) throw new Error("provider failure");
      }),
      revokeNotificationGrant: vi.fn(async () => undefined)
    };
    const errors: unknown[] = [];

    expect(await new ProviderRevocationWorker(
      fixture.db,
      provider as never,
      (error) => errors.push(error)
    ).drain()).toBe(1);
    expect(provider.revokeReplica).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    const jobs = await fixture.db.query<{
      replica_id: string;
      state: string;
    }>(
      "SELECT replica_id, state FROM provider_revocation_jobs ORDER BY created_at"
    );
    expect(jobs.rows.find(({ replica_id }) => replica_id === fixture.replicaId)?.state)
      .toBe("pending");
    expect(jobs.rows.find(({ replica_id }) => replica_id === secondReplicaId)?.state)
      .toBe("completed");
  });

  it("completes cleanup when the provider confirms the resource is already missing", async () => {
    const fixture = await capabilityFixture();
    await queueHostedGrantRevocation(
      fixture.db,
      fixture.userId,
      fixture.grantId,
      "missing_collection"
    );
    const provider = {
      revokeReplica: vi.fn(async () => undefined),
      revokeNotificationGrant: vi.fn(async () => {
        throw new HostedProviderResponseError(
          404,
          "hosted_collection_not_found",
          "Hosted collection not found."
        );
      })
    };
    const errors: unknown[] = [];

    expect(await new ProviderRevocationWorker(
      fixture.db,
      provider as never,
      (error) => errors.push(error)
    ).drain()).toBe(1);
    expect(errors).toEqual([]);
    expect((await fixture.db.query(
      "SELECT state, completed_at, last_error FROM provider_revocation_jobs"
    )).rows[0]).toEqual({
      state: "completed",
      completed_at: expect.any(Date),
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
