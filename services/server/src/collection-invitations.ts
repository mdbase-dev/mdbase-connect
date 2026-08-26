import { randomUUID } from "node:crypto";
import { resolveHostedCollectionAccess } from "./collection-access.js";
import {
  CollectionMembershipPolicyError,
  insertHostedCollectionMembershipPolicy,
  membershipPolicyPreset,
  type CollectionMembershipRole,
  type MembershipPolicySnapshot
} from "./collection-policy.js";
import type { DatabasePool, DatabaseQueryable } from "./db.js";
import { normalizeEmailAddress } from "./email-identity.js";
import { effectiveEntitlement } from "./entitlements.js";
import { audit } from "./platform/audit-events.js";
import {
  canonicalUserCode,
  randomToken,
  randomUserCode,
  tokenHash
} from "./security.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export class CollectionInvitationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CollectionInvitationError";
  }
}

export interface CreatedCollectionInvitation {
  id: string;
  collectionId: string;
  targetMode: "email" | "invitee_code";
  submittedEmail: string | null;
  role: CollectionMembershipRole;
  state: "pending";
  expiresAt: Date;
  token: string;
}

export async function createCollectionInvitationCode(
  db: DatabasePool,
  userId: string
): Promise<{ code: string; expiresAt: Date }> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const activeUser = await connection.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL FOR UPDATE",
      [userId]
    );
    if (!activeUser.rows[0]) throw invalidInvitation();
    await connection.query(
      `UPDATE collection_invitation_codes
       SET revoked_at = now()
       WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [userId]
    );
    const code = randomUserCode();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await connection.query(
      `INSERT INTO collection_invitation_codes
         (id, user_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), userId, tokenHash(canonicalUserCode(code)), expiresAt]
    );
    await connection.query("COMMIT");
    return { code, expiresAt };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function createHostedCollectionInvitation(
  db: DatabasePool,
  input: {
    collectionId: string;
    actorUserId: string;
    role: CollectionMembershipRole;
    collaboration?: boolean;
    target: { email: string } | { inviteeCode: string };
  }
): Promise<CreatedCollectionInvitation> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const collection = await lockActiveCollection(connection, input.collectionId);
    await ensureCollectionIdentity(
      connection,
      input.collectionId,
      collection.user_id
    );
    await requireSharingManager(
      connection,
      input.actorUserId,
      input.collectionId
    );
    const token = randomToken("cinv");
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const snapshot = membershipPolicyPreset(input.role, {
      collaboration: input.collaboration === true
    });
    let targetMode: "email" | "invitee_code";
    let submittedEmail: string | null = null;
    let targetUserId: string | null = null;
    let invitationCodeId: string | null = null;

    if ("email" in input.target) {
      targetMode = "email";
      submittedEmail = normalizeEmailAddress(input.target.email);
      targetUserId = await resolveEligibleTargetUser(
        connection,
        submittedEmail,
        collection.user_id,
        input.collectionId
      );
      await connection.query(
        `UPDATE collection_invitations
         SET state = 'revoked', revoked_at = now(), updated_at = now()
         WHERE collection_id = $1 AND state = 'pending'
           AND (submitted_email = $2 OR ($3::uuid IS NOT NULL AND target_user_id = $3))`,
        [input.collectionId, submittedEmail, targetUserId]
      );
    } else {
      targetMode = "invitee_code";
      const code = await connection.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM collection_invitation_codes
         WHERE code_hash = $1 AND consumed_at IS NULL
           AND revoked_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [tokenHash(canonicalUserCode(input.target.inviteeCode))]
      );
      const resolved = code.rows[0];
      const codeUser = resolved
        ? await connection.query<{ id: string }>(
            "SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL",
            [resolved.user_id]
          )
        : { rows: [] };
      if (!resolved || !codeUser.rows[0] || resolved.user_id === collection.user_id) {
        throw invalidInvitationCode();
      }
      const existing = await connection.query<{ id: string }>(
        `SELECT id FROM collection_memberships
         WHERE collection_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [input.collectionId, resolved.user_id]
      );
      if (existing.rows[0]) throw invalidInvitationCode();
      invitationCodeId = resolved.id;
      targetUserId = resolved.user_id;
      await connection.query(
        `UPDATE collection_invitations
         SET state = 'revoked', revoked_at = now(), updated_at = now()
         WHERE collection_id = $1 AND target_user_id = $2 AND state = 'pending'`,
        [input.collectionId, targetUserId]
      );
      await connection.query(
        "UPDATE collection_invitation_codes SET consumed_at = now() WHERE id = $1",
        [invitationCodeId]
      );
    }

    const invitationId = randomUUID();
    await insertInvitation(connection, {
      id: invitationId,
      collectionId: input.collectionId,
      actorUserId: input.actorUserId,
      targetMode,
      submittedEmail,
      targetUserId,
      invitationCodeId,
      token,
      expiresAt,
      snapshot
    });
    await audit(
      connection,
      input.actorUserId,
      "collection_invitation.created",
      invitationId,
      { collection_id: input.collectionId, role: input.role, target_mode: targetMode }
    );
    await connection.query("COMMIT");
    return {
      id: invitationId,
      collectionId: input.collectionId,
      targetMode,
      submittedEmail,
      role: input.role,
      state: "pending",
      expiresAt,
      token
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function acceptHostedCollectionInvitation(
  db: DatabasePool,
  input: { userId: string; token: string }
): Promise<{ collectionId: string; membershipId: string; role: CollectionMembershipRole }> {
  const located = await db.query<{ collection_id: string }>(
    "SELECT collection_id FROM collection_invitations WHERE token_hash = $1",
    [tokenHash(input.token)]
  );
  const collectionId = located.rows[0]?.collection_id;
  if (!collectionId) throw invalidInvitation();

  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const collection = await lockActiveCollection(connection, collectionId);
    const invitation = await connection.query<InvitationRow>(
      `SELECT * FROM collection_invitations
       WHERE token_hash = $1 AND collection_id = $2
       FOR UPDATE`,
      [tokenHash(input.token), collectionId]
    );
    const row = invitation.rows[0];
    if (
      !row
      || row.state !== "pending"
      || new Date(row.expires_at).getTime() <= Date.now()
      || row.target_user_id !== input.userId
      || row.target_user_id === collection.user_id
    ) {
      throw invalidInvitation();
    }
    const activeTarget = await connection.query<{ id: string }>(
      `SELECT id FROM users
       WHERE id = $1 AND suspended_at IS NULL
       FOR UPDATE`,
      [input.userId]
    );
    if (!activeTarget.rows[0]) throw invalidInvitation();
    if (
      row.submitted_email
      && !await hasVerifiedEmail(
        connection,
        input.userId,
        row.submitted_email
      )
    ) {
      throw invalidInvitation();
    }

    const ownerAccount = await connection.query<{ user_id: string }>(
      `SELECT user_id FROM account_storage_accounts
       WHERE user_id = $1 FOR UPDATE`,
      [collection.user_id]
    );
    if (!ownerAccount.rows[0]) throw seatUnavailable();
    const entitlement = await effectiveEntitlement(connection, collection.user_id);
    if (!entitlement) throw seatUnavailable();
    const seatUsage = await connection.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM account_collection_member_seats
       WHERE owner_user_id = $1 AND released_at IS NULL`,
      [collection.user_id]
    );
    if (Number(seatUsage.rows[0]?.count ?? 0) >= entitlement.maxCollectionMemberSeats) {
      throw seatUnavailable();
    }

    let policy;
    try {
      policy = await insertHostedCollectionMembershipPolicy(connection, {
        collectionId,
        ownerUserId: collection.user_id,
        userId: input.userId,
        invitedByUserId: row.invited_by_user_id,
        snapshot: invitationSnapshot(row)
      });
    } catch (error) {
      if (error instanceof CollectionMembershipPolicyError) {
        throw invalidInvitation();
      }
      throw error;
    }
    await connection.query(
      `INSERT INTO account_collection_member_seats
         (id, owner_user_id, membership_id, collection_id, member_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), collection.user_id, policy.membershipId,
        collectionId, input.userId]
    );
    const accepted = await connection.query(
      `UPDATE collection_invitations
       SET state = 'accepted', accepted_at = now(),
           accepted_membership_id = $2, updated_at = now()
       WHERE id = $1 AND state = 'pending'`,
      [row.id, policy.membershipId]
    );
    if (accepted.rowCount !== 1) throw invalidInvitation();
    await audit(
      connection,
      input.userId,
      "collection_invitation.accepted",
      row.id,
      {
        collection_id: collectionId,
        membership_id: policy.membershipId,
        role: policy.role
      }
    );
    await connection.query("COMMIT");
    return { collectionId, membershipId: policy.membershipId, role: policy.role };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function revokeHostedCollectionInvitation(
  db: DatabasePool,
  input: { collectionId: string; actorUserId: string; invitationId: string }
): Promise<boolean> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await lockActiveCollection(connection, input.collectionId);
    await requireSharingManager(
      connection,
      input.actorUserId,
      input.collectionId
    );
    const revoked = await connection.query(
      `UPDATE collection_invitations
       SET state = 'revoked', revoked_at = now(), updated_at = now()
       WHERE id = $1 AND collection_id = $2 AND state = 'pending'`,
      [input.invitationId, input.collectionId]
    );
    if (revoked.rowCount === 1) {
      await audit(
        connection,
        input.actorUserId,
        "collection_invitation.revoked",
        input.invitationId,
        { collection_id: input.collectionId }
      );
    }
    await connection.query("COMMIT");
    return revoked.rowCount === 1;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function listHostedCollectionMembers(
  db: DatabaseQueryable,
  actorUserId: string,
  collectionId: string
): Promise<Array<Record<string, unknown>>> {
  await requireSharingManager(db, actorUserId, collectionId);
  const collection = await db.query<{
    user_id: string;
    name: string;
    created_at: Date | string;
  }>(
    `SELECT collection.user_id, account.name, collection.created_at
     FROM hosted_collections collection
     JOIN users account ON account.id = collection.user_id
     WHERE collection.id = $1 AND collection.authority_state = 'active'`,
    [collectionId]
  );
  if (!collection.rows[0]) throw sharingNotFound();
  const memberships = await db.query<{
    id: string;
    name: string;
    role: CollectionMembershipRole;
    state: string;
    accepted_at: Date | string;
    revoked_at: Date | string | null;
  }>(
    `SELECT membership.id, account.name, policy.role, membership.state,
            membership.accepted_at, membership.revoked_at
     FROM collection_memberships membership
     JOIN users account ON account.id = membership.user_id
     JOIN collection_membership_policies policy
       ON policy.id = COALESCE(membership.pending_policy_id,
                               membership.current_policy_id)
     WHERE membership.collection_id = $1
       AND membership.state <> 'revoked'
     ORDER BY membership.accepted_at, membership.id`,
    [collectionId]
  );
  const owner = collection.rows[0];
  return [
    {
      kind: "owner",
      name: owner.name,
      role: "owner",
      state: "active",
      accepted_at: owner.created_at
    },
    ...memberships.rows.map((membership) => ({
      kind: "member",
      id: membership.id,
      name: membership.name,
      role: membership.role,
      state: membership.state,
      accepted_at: membership.accepted_at,
      revoked_at: membership.revoked_at
    }))
  ];
}

export async function listHostedCollectionInvitations(
  db: DatabaseQueryable,
  actorUserId: string,
  collectionId: string
): Promise<Array<Record<string, unknown>>> {
  await requireSharingManager(db, actorUserId, collectionId);
  const rows = await db.query<{
    id: string;
    target_mode: string;
    submitted_email: string | null;
    role: string;
    state: string;
    expires_at: Date | string;
    created_at: Date | string;
  }>(
    `SELECT id, target_mode, submitted_email, role, state, expires_at, created_at
     FROM collection_invitations
     WHERE collection_id = $1
     ORDER BY created_at DESC`,
    [collectionId]
  );
  return rows.rows.map((row) => ({
    id: row.id,
    target_mode: row.target_mode,
    submitted_email: row.submitted_email,
    role: row.role,
    state: row.state === "pending"
      && new Date(row.expires_at).getTime() <= Date.now()
      ? "expired"
      : row.state,
    expires_at: row.expires_at,
    created_at: row.created_at
  }));
}

interface InvitationRow {
  id: string;
  invited_by_user_id: string | null;
  submitted_email: string | null;
  target_user_id: string | null;
  role: CollectionMembershipRole;
  preset_version: number;
  actions: MembershipPolicySnapshot["actions"];
  operations: MembershipPolicySnapshot["operations"];
  scope_ceiling: MembershipPolicySnapshot["scopeCeiling"];
  file_ceiling: MembershipPolicySnapshot["fileCeiling"];
  collaboration_ceiling: MembershipPolicySnapshot["collaborationCeiling"];
  state: string;
  expires_at: Date | string;
}

async function requireSharingManager(
  db: DatabaseQueryable,
  userId: string,
  collectionId: string
): Promise<void> {
  const access = await resolveHostedCollectionAccess(db, userId, collectionId);
  if (!access?.actions.has("members.manage")) throw sharingNotFound();
}

async function lockActiveCollection(
  db: DatabaseQueryable,
  collectionId: string
): Promise<{ user_id: string }> {
  const collection = await db.query<{ user_id: string }>(
    `SELECT user_id FROM hosted_collections
     WHERE id = $1 AND authority_state = 'active'
     FOR UPDATE`,
    [collectionId]
  );
  if (!collection.rows[0]) throw sharingNotFound();
  return collection.rows[0];
}

async function ensureCollectionIdentity(
  db: DatabaseQueryable,
  collectionId: string,
  ownerUserId: string
): Promise<void> {
  await db.query(
    `INSERT INTO collection_identities (id, owner_user_id)
     VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [collectionId, ownerUserId]
  );
  const identity = await db.query<{ owner_user_id: string }>(
    "SELECT owner_user_id FROM collection_identities WHERE id = $1 FOR UPDATE",
    [collectionId]
  );
  if (identity.rows[0]?.owner_user_id !== ownerUserId) throw sharingNotFound();
}

async function resolveEligibleTargetUser(
  db: DatabaseQueryable,
  normalizedEmail: string,
  ownerUserId: string,
  collectionId: string
): Promise<string | null> {
  const emailIdentity = await db.query<{ user_id: string }>(
    `SELECT identity.user_id
     FROM email_identities identity
     JOIN users account ON account.id = identity.user_id
     WHERE identity.normalized_email = $1
       AND identity.verified_at IS NOT NULL
       AND identity.retired_at IS NULL
       AND account.suspended_at IS NULL`,
    [normalizedEmail]
  );
  const externalIdentity = emailIdentity.rows[0]
    ? { rows: [] }
    : await db.query<{ user_id: string }>(
        `SELECT identity.user_id
         FROM external_identities identity
         JOIN users account ON account.id = identity.user_id
         WHERE identity.normalized_email = $1
           AND identity.email_verified = true
           AND account.suspended_at IS NULL`,
        [normalizedEmail]
      );
  const userId = emailIdentity.rows[0]?.user_id
    ?? externalIdentity.rows[0]?.user_id;
  if (!userId || userId === ownerUserId) return null;
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM collection_memberships
     WHERE collection_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [collectionId, userId]
  );
  return existing.rows[0] ? null : userId;
}

async function hasVerifiedEmail(
  db: DatabaseQueryable,
  userId: string,
  normalizedEmail: string
): Promise<boolean> {
  const emailIdentity = await db.query<{ id: string }>(
    `SELECT id FROM email_identities
     WHERE user_id = $1 AND normalized_email = $2
       AND verified_at IS NOT NULL AND retired_at IS NULL`,
    [userId, normalizedEmail]
  );
  if (emailIdentity.rows[0]) return true;
  const externalIdentity = await db.query<{ provider: string }>(
    `SELECT provider FROM external_identities
     WHERE user_id = $1 AND normalized_email = $2
       AND email_verified = true`,
    [userId, normalizedEmail]
  );
  return Boolean(externalIdentity.rows[0]);
}

async function insertInvitation(
  db: DatabaseQueryable,
  input: {
    id: string;
    collectionId: string;
    actorUserId: string;
    targetMode: "email" | "invitee_code";
    submittedEmail: string | null;
    targetUserId: string | null;
    invitationCodeId: string | null;
    token: string;
    expiresAt: Date;
    snapshot: MembershipPolicySnapshot;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO collection_invitations
       (id, collection_id, invited_by_user_id, target_mode, submitted_email,
        target_user_id, invitation_code_id, token_hash, role, preset_version,
        actions, operations, scope_ceiling, file_ceiling,
        collaboration_ceiling, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
             $16)`,
    [
      input.id,
      input.collectionId,
      input.actorUserId,
      input.targetMode,
      input.submittedEmail,
      input.targetUserId,
      input.invitationCodeId,
      tokenHash(input.token),
      input.snapshot.role,
      input.snapshot.presetVersion,
      JSON.stringify(input.snapshot.actions),
      JSON.stringify(input.snapshot.operations),
      JSON.stringify(input.snapshot.scopeCeiling),
      JSON.stringify(input.snapshot.fileCeiling),
      input.snapshot.collaborationCeiling
        ? JSON.stringify(input.snapshot.collaborationCeiling)
        : null,
      input.expiresAt
    ]
  );
}

function invitationSnapshot(row: InvitationRow): MembershipPolicySnapshot {
  return {
    role: row.role,
    presetVersion: Number(row.preset_version),
    actions: row.actions,
    operations: row.operations,
    scopeCeiling: row.scope_ceiling,
    fileCeiling: row.file_ceiling,
    collaborationCeiling: row.collaboration_ceiling
  };
}

function invalidInvitation(): CollectionInvitationError {
  return new CollectionInvitationError(
    "invalid_collection_invitation",
    "The collection invitation is invalid or unavailable."
  );
}

function invalidInvitationCode(): CollectionInvitationError {
  return new CollectionInvitationError(
    "invalid_collection_invitation_code",
    "The collection invitation code is invalid or unavailable."
  );
}

function seatUnavailable(): CollectionInvitationError {
  return new CollectionInvitationError(
    "collection_member_seat_unavailable",
    "The collection owner does not have an available member seat."
  );
}

function sharingNotFound(): CollectionInvitationError {
  return new CollectionInvitationError(
    "collection_sharing_not_found",
    "Collection sharing is unavailable."
  );
}
