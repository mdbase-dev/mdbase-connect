import { randomUUID } from "node:crypto";
import {
  requireCollectionAction,
  resolveHostedCollectionAccess
} from "./collection-access.js";
import {
  CollectionMembershipPolicyError,
  membershipPolicyPreset,
  type CollectionMembershipRole
} from "./collection-policy.js";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryable
} from "./db.js";
import { audit } from "./platform/audit-events.js";

export interface MembershipTransitionResult {
  membershipId: string;
  state: "active" | "changing" | "revoking" | "revoked";
  policyId?: string;
  policyRevision?: number;
  pendingProviderRevocations: number;
}

export async function changeHostedCollectionMembershipRole(
  db: DatabasePool,
  input: {
    collectionId: string;
    actorUserId: string;
    membershipId: string;
    role: CollectionMembershipRole;
  }
): Promise<MembershipTransitionResult> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await lockActiveHostedCollection(connection, input.collectionId);
    requireCollectionAction(
      await resolveHostedCollectionAccess(connection, input.actorUserId, input.collectionId),
      "members.manage"
    );
    const membership = await activeMembershipForUpdate(
      connection,
      input.collectionId,
      input.membershipId
    );
    const revision = Number(membership.current_policy_revision) + 1;
    const policyId = randomUUID();
    const preset = membershipPolicyPreset(input.role);
    await connection.query(
      `INSERT INTO collection_membership_policies
         (id, membership_id, revision, role, preset_version, actions,
          operations, scope_ceiling, file_ceiling, collaboration_ceiling)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
               $9::jsonb, $10::jsonb)`,
      [
        policyId,
        membership.id,
        revision,
        preset.role,
        preset.presetVersion,
        JSON.stringify(preset.actions),
        JSON.stringify(preset.operations),
        JSON.stringify(preset.scopeCeiling),
        JSON.stringify(preset.fileCeiling),
        preset.collaborationCeiling
          ? JSON.stringify(preset.collaborationCeiling)
          : null
      ]
    );
    const pendingProviderRevocations = await revokeDerivedCapabilities(
      connection,
      membership.id,
      membership.user_id,
      input.collectionId,
      "membership_role_change"
    );
    if (pendingProviderRevocations === 0) {
      await connection.query(
        `UPDATE collection_memberships
         SET current_policy_id = $2, current_policy_revision = $3,
             state = 'active', updated_at = now()
         WHERE id = $1`,
        [membership.id, policyId, revision]
      );
    } else {
      await connection.query(
        `UPDATE collection_memberships
         SET pending_policy_id = $2, pending_policy_revision = $3,
             state = 'changing', updated_at = now()
         WHERE id = $1`,
        [membership.id, policyId, revision]
      );
    }
    await audit(
      connection,
      input.actorUserId,
      "collection_membership.role_change_requested",
      membership.id,
      {
        collection_id: input.collectionId,
        role: input.role,
        policy_revision: revision,
        state: pendingProviderRevocations === 0 ? "active" : "changing"
      }
    );
    if (pendingProviderRevocations === 0) {
      await audit(
        connection,
        input.actorUserId,
        "collection_membership.role_changed",
        membership.id,
        { collection_id: input.collectionId, policy_revision: revision }
      );
    }
    await connection.query("COMMIT");
    return {
      membershipId: membership.id,
      state: pendingProviderRevocations === 0 ? "active" : "changing",
      policyId,
      policyRevision: revision,
      pendingProviderRevocations
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function revokeHostedCollectionMembership(
  db: DatabasePool,
  input: {
    collectionId: string;
    actorUserId: string;
    membershipId: string;
  }
): Promise<MembershipTransitionResult> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await lockActiveHostedCollection(connection, input.collectionId);
    requireCollectionAction(
      await resolveHostedCollectionAccess(connection, input.actorUserId, input.collectionId),
      "members.manage"
    );
    const membership = await activeMembershipForUpdate(
      connection,
      input.collectionId,
      input.membershipId
    );
    const pendingProviderRevocations = await revokeDerivedCapabilities(
      connection,
      membership.id,
      membership.user_id,
      input.collectionId,
      "membership_revoked"
    );
    if (pendingProviderRevocations === 0) {
      await connection.query(
        `UPDATE collection_memberships
         SET state = 'revoked', revoked_at = now(), updated_at = now()
         WHERE id = $1`,
        [membership.id]
      );
      await connection.query(
        `UPDATE account_collection_member_seats
         SET released_at = COALESCE(released_at, now())
         WHERE membership_id = $1`,
        [membership.id]
      );
    } else {
      await connection.query(
        `UPDATE collection_memberships
         SET state = 'revoking', updated_at = now()
         WHERE id = $1`,
        [membership.id]
      );
    }
    await audit(
      connection,
      input.actorUserId,
      "collection_membership.revocation_requested",
      membership.id,
      {
        collection_id: input.collectionId,
        state: pendingProviderRevocations === 0 ? "revoked" : "revoking"
      }
    );
    if (pendingProviderRevocations === 0) {
      await audit(
        connection,
        input.actorUserId,
        "collection_membership.revoked",
        membership.id,
        { collection_id: input.collectionId }
      );
    }
    await connection.query("COMMIT");
    return {
      membershipId: membership.id,
      state: pendingProviderRevocations === 0 ? "revoked" : "revoking",
      pendingProviderRevocations
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function finalizeReadyMembershipTransitions(
  db: DatabasePool
): Promise<number> {
  const candidates = await db.query<{ id: string; collection_id: string }>(
    `SELECT id, collection_id FROM collection_memberships
     WHERE state IN ('changing', 'revoking')`
  );
  let finalized = 0;
  for (const candidate of candidates.rows) {
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "SELECT id FROM hosted_collections WHERE id = $1 FOR UPDATE",
        [candidate.collection_id]
      );
      const current = await connection.query<{
        state: "changing" | "revoking";
        pending_policy_id: string | null;
        pending_policy_revision: number | null;
      }>(
        `SELECT state, pending_policy_id, pending_policy_revision
         FROM collection_memberships
         WHERE id = $1 AND collection_id = $2
           AND state IN ('changing', 'revoking')
         FOR UPDATE`,
        [candidate.id, candidate.collection_id]
      );
      const membership = current.rows[0];
      if (!membership) {
        await connection.query("COMMIT");
        continue;
      }
      const pending = await connection.query<{ count: string | number }>(
        `SELECT count(*) AS count
         FROM hosted_replicas replica
         JOIN provider_revocation_jobs job ON job.replica_id = replica.id
         WHERE replica.membership_id = $1 AND job.completed_at IS NULL`,
        [candidate.id]
      );
      if (Number(pending.rows[0]?.count ?? 0) !== 0) {
        await connection.query("COMMIT");
        continue;
      }
      if (membership.state === "changing") {
        if (!membership.pending_policy_id || !membership.pending_policy_revision) {
          await connection.query("ROLLBACK");
          continue;
        }
        const updated = await connection.query(
          `UPDATE collection_memberships
           SET current_policy_id = pending_policy_id,
               current_policy_revision = pending_policy_revision,
               pending_policy_id = NULL, pending_policy_revision = NULL,
               state = 'active', updated_at = now()
           WHERE id = $1 AND state = 'changing'
             AND pending_policy_id = $2 AND pending_policy_revision = $3`,
          [candidate.id, membership.pending_policy_id,
            membership.pending_policy_revision]
        );
        if (updated.rowCount === 1) {
          await audit(
            connection,
            null,
            "collection_membership.role_changed",
            candidate.id,
            {
              collection_id: candidate.collection_id,
              policy_revision: membership.pending_policy_revision
            }
          );
        }
        finalized += updated.rowCount ?? 0;
      } else {
        const updated = await connection.query(
          `UPDATE collection_memberships
           SET state = 'revoked', revoked_at = COALESCE(revoked_at, now()),
               updated_at = now()
           WHERE id = $1 AND state = 'revoking'`,
          [candidate.id]
        );
        if (updated.rowCount === 1) {
          await connection.query(
            `UPDATE account_collection_member_seats
             SET released_at = COALESCE(released_at, now())
             WHERE membership_id = $1`,
            [candidate.id]
          );
        }
        if (updated.rowCount === 1) {
          await audit(
            connection,
            null,
            "collection_membership.revoked",
            candidate.id,
            { collection_id: candidate.collection_id }
          );
        }
        finalized += updated.rowCount ?? 0;
      }
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
  return finalized;
}

async function lockActiveHostedCollection(
  db: DatabaseQueryable,
  collectionId: string
): Promise<void> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM hosted_collections
     WHERE id = $1 AND authority_state = 'active'
     FOR UPDATE`,
    [collectionId]
  );
  if (!result.rows[0]) {
    throw new CollectionMembershipPolicyError(
      "collection_unavailable",
      "The collection is not available for membership changes."
    );
  }
}

async function activeMembershipForUpdate(
  db: DatabaseQueryable,
  collectionId: string,
  membershipId: string
): Promise<{
  id: string;
  user_id: string;
  current_policy_revision: number;
}> {
  const result = await db.query<{
    id: string;
    user_id: string;
    current_policy_revision: number;
  }>(
    `SELECT id, user_id, current_policy_revision
     FROM collection_memberships
     WHERE id = $1 AND collection_id = $2
       AND state = 'active' AND revoked_at IS NULL
     FOR UPDATE`,
    [membershipId, collectionId]
  );
  const membership = result.rows[0];
  if (!membership) {
    throw new CollectionMembershipPolicyError(
      "membership_unavailable",
      "The membership is not available for changes."
    );
  }
  return membership;
}

async function revokeDerivedCapabilities(
  db: DatabaseConnection,
  membershipId: string,
  userId: string,
  collectionId: string,
  reason: string
): Promise<number> {
  const replicas = await db.query<{ id: string }>(
    `SELECT id FROM hosted_replicas
     WHERE membership_id = $1 AND collection_id = $2
       AND authorized_user_id = $3 AND revoked_at IS NULL
     FOR UPDATE`,
    [membershipId, collectionId, userId]
  );
  const grants = await db.query<{
    id: string;
    hosted_replica_id: string;
  }>(
    `SELECT id, hosted_replica_id FROM grants
     WHERE membership_id = $1
       AND hosted_replica_id IN (
         SELECT id FROM hosted_replicas
         WHERE membership_id = $1 AND collection_id = $2
           AND authorized_user_id = $3
       )`,
    [membershipId, collectionId, userId]
  );
  const grantByReplica = new Map(
    grants.rows.map((grant) => [grant.hosted_replica_id, grant.id])
  );
  await db.query(
    `UPDATE grants
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE membership_id = $1 AND user_id = $2
       AND logical_collection_id = $3`,
    [membershipId, userId, collectionId]
  );
  await db.query(
    `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now())
     WHERE grant_id IN (
       SELECT id FROM grants WHERE membership_id = $1
     )`,
    [membershipId]
  );
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
     WHERE grant_id IN (
       SELECT id FROM grants WHERE membership_id = $1
     )`,
    [membershipId]
  );
  await db.query(
    `UPDATE hosted_replicas
     SET revoked_at = COALESCE(revoked_at, now()), token_hash = NULL
     WHERE membership_id = $1 AND collection_id = $2
       AND authorized_user_id = $3`,
    [membershipId, collectionId, userId]
  );
  await db.query(
    `DELETE FROM mirror_pairing_requests
     WHERE replica_id IN (
       SELECT id FROM hosted_replicas WHERE membership_id = $1
     )`,
    [membershipId]
  );
  await db.query(
    `UPDATE authorization_requests
     SET denied_at = COALESCE(denied_at, now())
     WHERE user_id = $1 AND collection_id = $2
       AND completed_at IS NULL AND denied_at IS NULL`,
    [userId, collectionId]
  );
  for (const replica of replicas.rows) {
    await db.query(
      `INSERT INTO provider_revocation_jobs
         (id, replica_id, grant_id, collection_id, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), replica.id, grantByReplica.get(replica.id) ?? null,
        collectionId, reason]
    );
  }
  return replicas.rows.length;
}
