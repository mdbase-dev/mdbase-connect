import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import {
  InstanceAdminConflictError,
  InstanceAdminService
} from "./instance-admin.js";
import { tokenHash } from "./security.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("instance administration", () => {
  it("lists users with bounded cursor pagination and exact account details", async () => {
    const db = await fixture();
    const firstId = "10000000-0000-4000-8000-000000000001";
    const secondId = "20000000-0000-4000-8000-000000000002";
    const thirdId = "30000000-0000-4000-8000-000000000003";
    await seedUser(db, firstId, "first@example.com", "First", "2026-01-01T00:00:00Z");
    await seedUser(db, secondId, "second@example.com", "Second", "2026-01-02T00:00:00Z");
    await seedUser(db, thirdId, "third@example.com", "Third", "2026-01-03T00:00:00Z");
    await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [secondId]);
    await db.query(
      `INSERT INTO external_identities
         (provider, subject, user_id, email, email_verified, normalized_email)
       VALUES ('github', 'subject-1', $1, 'first@example.com', true, 'first@example.com')`,
      [firstId]
    );
    const service = new InstanceAdminService(db);

    const firstPage = await service.listUsers({ limit: 2 });
    expect(firstPage.users.map((user) => user.id)).toEqual([thirdId, secondId]);
    expect(firstPage.next_cursor).toEqual(expect.any(String));
    const secondPage = await service.listUsers({
      limit: 2,
      cursor: firstPage.next_cursor!
    });
    expect(secondPage.users.map((user) => user.id)).toEqual([firstId]);
    expect(secondPage.next_cursor).toBeNull();

    const suspended = await service.listUsers({ status: "suspended" });
    expect(suspended.users).toEqual([
      expect.objectContaining({ id: secondId, status: "suspended" })
    ]);
    const detail = await service.showUser("FIRST@example.com");
    expect(detail.user).toMatchObject({
      id: firstId,
      email: "first@example.com",
      status: "active",
      external_identities: [{
        provider: "github",
        email: "first@example.com",
        email_verified: true
      }]
    });
  });

  it("suspends every credential surface, preserves data, and never revives old credentials", async () => {
    const db = await fixture();
    const userId = "10000000-0000-4000-8000-000000000010";
    const connectorId = "20000000-0000-4000-8000-000000000010";
    const collectionId = "30000000-0000-4000-8000-000000000010";
    const replicaId = "40000000-0000-4000-8000-000000000010";
    const applicationId = "50000000-0000-4000-8000-000000000010";
    const grantId = "60000000-0000-4000-8000-000000000010";
    const pairingId = "70000000-0000-4000-8000-000000000010";
    const mirrorPairingId = "80000000-0000-4000-8000-000000000010";
    const adoptionId = "90000000-0000-4000-8000-000000000010";
    await seedUser(db, userId, "person@example.com", "Person");
    await db.query(
      `INSERT INTO sessions
         (id, user_id, token_hash, expires_at, client_name)
       VALUES ($1, $2, $3, now() + interval '1 day', 'Browser')`,
      [randomUUID(), userId, tokenHash("session")]
    );
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, 'Laptop', $3)`,
      [connectorId, userId, tokenHash("connector")]
    );
    await db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, provider_url)
       VALUES ($1, $2, 'Hosted notes', 'blank', 'https://provider.example')`,
      [collectionId, userId]
    );
    await db.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, name, purpose, mode, token_hash)
       VALUES ($1, $2, 'Application', 'application', 'read_write', $3)`,
      [replicaId, collectionId, tokenHash("provider")]
    );
    await db.query(
      `INSERT INTO pairing_requests
         (id, secret_hash, connector_name, user_id, approved_at, expires_at)
       VALUES ($1, $2, 'Pending computer', $3, now(), now() + interval '1 day')`,
      [pairingId, tokenHash("pairing-secret"), userId]
    );
    await db.query(
      `INSERT INTO mirror_pairing_requests
         (id, secret_hash, mirror_name, mode, user_id, collection_id,
          replica_id, approved_at, consumed_at, expires_at)
       VALUES ($1, $2, 'Mirror', 'read_write', $3, $4, $5, now(), now(),
               now() + interval '1 day')`,
      [
        mirrorPairingId,
        tokenHash("mirror-pairing-secret"),
        userId,
        collectionId,
        replicaId
      ]
    );
    await db.query(
      `INSERT INTO authority_adoption_requests
         (id, secret_hash, collection_id, display_name, source_name,
          user_id, state, expires_at)
       VALUES ($1, $2, $3, 'Imported notes', 'Laptop', $4, 'approved',
               now() + interval '1 day')`,
      [adoptionId, tokenHash("adoption-secret"), randomUUID(), userId]
    );
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, 'web:https://app.example', 'App', 'https://app.example',
         '["https://app.example/callback"]'::jsonb)`,
      [applicationId]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id,
          hosted_replica_id, operations)
       VALUES ($1, $2, $3, $4, $5, '["read"]'::jsonb)`,
      [grantId, userId, applicationId, collectionId, replicaId]
    );
    await db.query(
      `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), tokenHash("access"), grantId]
    );
    await db.query(
      `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), tokenHash("refresh"), grantId]
    );
    await db.query(
      `INSERT INTO push_channels (id, grant_id, installation_id)
       VALUES ($1, $2, 'installation')`,
      [randomUUID(), grantId]
    );
    const revokeReplica = vi.fn(async () => {});
    const abortAuthorityImport = vi.fn(async () => {});
    const service = new InstanceAdminService(db, {
      revokeReplica,
      abortAuthorityImport
    });
    const operationId = randomUUID();
    const mutation = {
      operationId,
      actor: "operator:callum",
      reason: "Contain a compromised account"
    };

    const suspended = await service.suspendUser("person@example.com", mutation);
    expect(suspended).toEqual({
      operation_id: operationId,
      user_id: userId,
      status: "suspended",
      changed: true,
      revoked: {
        sessions: 1,
        connectors: 1,
        pairing_requests: 1,
        mirror_pairing_credentials: 1,
        authority_adoption_credentials: 1,
        grants: 1,
        access_tokens: 1,
        refresh_tokens: 1,
        notification_channels: 1,
        hosted_replicas: 1,
        hosted_authority_imports: 1
      }
    });
    expect(revokeReplica).toHaveBeenCalledWith(replicaId);
    expect(abortAuthorityImport).toHaveBeenCalledWith(adoptionId);

    const replayed = await service.suspendUser(userId, mutation);
    expect(replayed).toEqual(suspended);
    expect(revokeReplica).toHaveBeenCalledTimes(1);
    expect(abortAuthorityImport).toHaveBeenCalledTimes(1);
    await expect(service.restoreUser(userId, {
      ...mutation,
      reason: "Different request with a reused identifier"
    })).rejects.toBeInstanceOf(InstanceAdminConflictError);

    const state = await db.query<{
      suspended_at: Date | null;
      session_epoch: string | number;
      session_revoked: Date | null;
      connector_revoked: Date | null;
      grant_revoked: Date | null;
      access_revoked: Date | null;
      refresh_revoked: Date | null;
      channel_disabled: Date | null;
      replica_revoked: Date | null;
      replica_token_hash: string | null;
      pairing_revoked: Date | null;
      mirror_pairing_revoked: Date | null;
    }>(
      `SELECT u.suspended_at, u.session_epoch,
        s.revoked_at AS session_revoked,
        c.revoked_at AS connector_revoked,
        g.revoked_at AS grant_revoked,
        at.revoked_at AS access_revoked,
        rt.revoked_at AS refresh_revoked,
        pc.disabled_at AS channel_disabled,
        hr.revoked_at AS replica_revoked,
        hr.token_hash AS replica_token_hash,
        pr.revoked_at AS pairing_revoked,
        mpr.revoked_at AS mirror_pairing_revoked
       FROM users u
       JOIN sessions s ON s.user_id = u.id
       JOIN connectors c ON c.user_id = u.id
       JOIN grants g ON g.user_id = u.id
       JOIN access_tokens at ON at.grant_id = g.id
       JOIN refresh_tokens rt ON rt.grant_id = g.id
       JOIN push_channels pc ON pc.grant_id = g.id
       JOIN hosted_replicas hr ON hr.id = g.hosted_replica_id
       JOIN pairing_requests pr ON pr.user_id = u.id
       JOIN mirror_pairing_requests mpr ON mpr.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    expect(state.rows[0]).toEqual(expect.objectContaining({
      suspended_at: expect.any(Date),
      session_revoked: expect.any(Date),
      connector_revoked: expect.any(Date),
      grant_revoked: expect.any(Date),
      access_revoked: expect.any(Date),
      refresh_revoked: expect.any(Date),
      channel_disabled: expect.any(Date),
      replica_revoked: expect.any(Date),
      replica_token_hash: null,
      pairing_revoked: expect.any(Date),
      mirror_pairing_revoked: expect.any(Date)
    }));
    const adoption = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM authority_adoption_requests WHERE id = $1",
      [adoptionId]
    );
    expect(adoption.rows[0]?.revoked_at).toBeInstanceOf(Date);

    const restoreOperationId = randomUUID();
    const restored = await service.restoreUser(userId, {
      operationId: restoreOperationId,
      actor: "operator:callum",
      reason: "Investigation completed"
    });
    expect(restored).toEqual({
      operation_id: restoreOperationId,
      user_id: userId,
      status: "active",
      changed: true,
      credentials_restored: false,
      revoked: {
        sessions: 0,
        connectors: 0,
        pairing_requests: 0,
        mirror_pairing_credentials: 0,
        authority_adoption_credentials: 0,
        grants: 0,
        access_tokens: 0,
        refresh_tokens: 0,
        notification_channels: 0,
        hosted_replicas: 0,
        hosted_authority_imports: 0
      }
    });
    const afterRestore = await service.showUser(userId);
    expect(afterRestore.user).toMatchObject({
      status: "active",
      active_sessions: 0,
      active_connectors: 0,
      active_grants: 0,
      hosted_collections: 1
    });
  });

  it("rolls back local suspension if hosted credential revocation fails", async () => {
    const db = await fixture();
    const userId = "10000000-0000-4000-8000-000000000020";
    const collectionId = "20000000-0000-4000-8000-000000000020";
    await seedUser(db, userId, "failure@example.com", "Failure");
    await db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, provider_url)
       VALUES ($1, $2, 'Hosted notes', 'blank', 'https://provider.example')`,
      [collectionId, userId]
    );
    await db.query(
      `INSERT INTO hosted_replicas
         (id, collection_id, name, purpose, mode, token_hash)
       VALUES ($1, $2, 'Mirror', 'mirror', 'read_write', $3)`,
      [randomUUID(), collectionId, tokenHash("provider")]
    );
    const service = new InstanceAdminService(db, {
      async revokeReplica() {
        throw new Error("provider unavailable");
      }
    });

    await expect(service.suspendUser(userId, {
      operationId: randomUUID(),
      actor: "operator:callum",
      reason: "Contain account"
    })).rejects.toThrow("provider unavailable");
    const user = await db.query<{ suspended_at: Date | null }>(
      "SELECT suspended_at FROM users WHERE id = $1",
      [userId]
    );
    expect(user.rows[0]?.suspended_at).toBeNull();
    expect((await db.query("SELECT operation_id FROM operator_operations")).rows)
      .toHaveLength(0);
  });

  it("revokes sessions idempotently without disabling the account", async () => {
    const db = await fixture();
    const userId = "10000000-0000-4000-8000-000000000030";
    await seedUser(db, userId, "sessions@example.com", "Sessions");
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), userId, tokenHash("session")]
    );
    const service = new InstanceAdminService(db);
    const mutation = {
      operationId: randomUUID(),
      actor: "operator:callum",
      reason: "Sign out every browser"
    };

    expect(await service.revokeUserSessions(userId, mutation)).toEqual({
      operation_id: mutation.operationId,
      user_id: userId,
      revoked_sessions: 1
    });
    expect(await service.revokeUserSessions(userId, mutation)).toEqual({
      operation_id: mutation.operationId,
      user_id: userId,
      revoked_sessions: 1
    });
    expect((await service.showUser(userId)).user.status).toBe("active");
  });

  it("lists, inspects, and idempotently revokes invitations with audit history", async () => {
    const db = await fixture();
    const activeId = "10000000-0000-4000-8000-000000000040";
    const expiredId = "20000000-0000-4000-8000-000000000040";
    await db.query(
      `INSERT INTO invitations
         (id, email, normalized_email, token_hash, created_by, expires_at)
       VALUES
         ($1, 'active@example.com', 'active@example.com', $2,
          'operator:seed', now() + interval '1 day'),
         ($3, 'expired@example.com', 'expired@example.com', $4,
          'operator:seed', now() - interval '1 day')`,
      [activeId, tokenHash("active"), expiredId, tokenHash("expired")]
    );
    const service = new InstanceAdminService(db);
    const active = await service.listInvitations({ status: "active" });
    expect(active.invitations).toEqual([
      expect.objectContaining({ id: activeId, status: "active" })
    ]);
    expect((await service.showInvitation(expiredId)).invitation.status)
      .toBe("expired");
    const mutation = {
      operationId: randomUUID(),
      actor: "operator:callum",
      reason: "Participant withdrew"
    };
    expect(await service.revokeInvitation(activeId, mutation)).toEqual({
      operation_id: mutation.operationId,
      invitation_id: activeId,
      status: "revoked",
      changed: true
    });
    expect(await service.revokeInvitation(activeId, mutation)).toEqual({
      operation_id: mutation.operationId,
      invitation_id: activeId,
      status: "revoked",
      changed: true
    });
    const audit = await service.listAuditEvents({
      eventType: "invitation.revoked",
      limit: 1
    });
    expect(audit.events).toEqual([
      expect.objectContaining({
        event_type: "invitation.revoked",
        subject_id: activeId,
        metadata: expect.objectContaining({
          operation_id: mutation.operationId
        })
      })
    ]);
  });
});

async function fixture(): Promise<DatabasePool> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  return db;
}

async function seedUser(
  db: DatabasePool,
  id: string,
  email: string,
  name: string,
  createdAt = "2026-01-01T00:00:00Z"
): Promise<void> {
  await db.query(
    `INSERT INTO users (id, email, name, created_at)
     VALUES ($1, $2, $3, $4)`,
    [id, email, name, createdAt]
  );
}
