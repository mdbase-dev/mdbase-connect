import { randomUUID } from "node:crypto";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryable
} from "./db.js";
import { normalizeEmailAddress } from "./email-identity.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface HostedReplicaRevoker {
  revokeReplica(replicaId: string): Promise<void>;
  abortAuthorityImport?(transferId: string): Promise<void>;
}

export interface OperatorMutation {
  actor: string;
  reason: string;
  operationId: string;
}

export interface UserPageInput {
  limit?: number;
  cursor?: string;
  status?: "active" | "suspended";
}

export interface InvitationPageInput {
  limit?: number;
  cursor?: string;
  status?: "active" | "accepted" | "revoked" | "expired";
}

export interface BetaAccessRequestPageInput {
  limit?: number;
  cursor?: string;
  status?: "pending" | "invited";
}

export interface AuditPageInput {
  limit?: number;
  cursor?: string;
  userId?: string;
  eventType?: string;
}

interface UserSummaryRow {
  id: string;
  email: string | null;
  name: string;
  suspended_at: Date | string | null;
  created_at: Date | string;
}

interface InvitationRow {
  id: string;
  email: string;
  created_by: string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  revoked_at: Date | string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  send_count: number | string;
  last_sent_at: Date | string | null;
  created_at: Date | string;
}

interface BetaAccessRequestRow {
  id: string;
  email: string;
  invitation_id: string | null;
  invited_at: Date | string | null;
  requested_at: Date | string;
}

interface AuditRow {
  id: string;
  user_id: string | null;
  event_type: string;
  subject_id: string | null;
  metadata: unknown;
  created_at: Date | string;
}

interface StoredOperationRow {
  action: string;
  target_type: string;
  target_id: string;
  actor: string;
  reason: string;
  result: unknown;
}

export class InstanceAdminNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceAdminNotFoundError";
  }
}

export class InstanceAdminConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceAdminConflictError";
  }
}

export class InstanceAdminService {
  constructor(
    private readonly db: DatabasePool,
    private readonly hostedReplicaRevoker?: HostedReplicaRevoker
  ) {}

  async listUsers(input: UserPageInput = {}) {
    const limit = pageSize(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (input.status === "active") {
      conditions.push("u.suspended_at IS NULL");
    } else if (input.status === "suspended") {
      conditions.push("u.suspended_at IS NOT NULL");
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(u.created_at < $${values.length - 1}
          OR (u.created_at = $${values.length - 1} AND u.id < $${values.length}))`
      );
    }
    values.push(limit + 1);
    const result = await this.db.query<UserSummaryRow>(
      `SELECT u.id, u.email, u.name, u.suspended_at, u.created_at
       FROM users u
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT $${values.length}`,
      values
    );
    const rows = result.rows.slice(0, limit);
    return {
      users: await hydrateUsers(this.db, rows),
      next_cursor: result.rows.length > limit && rows.length
        ? encodeCursor(rows[rows.length - 1]!.created_at, rows[rows.length - 1]!.id)
        : null
    };
  }

  async showUser(reference: string) {
    const userId = await resolveUserId(this.db, reference);
    const result = await this.db.query<UserSummaryRow>(
      `SELECT id, email, name, suspended_at, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) throw new InstanceAdminNotFoundError("User was not found.");
    const [summary] = await hydrateUsers(this.db, [row]);
    const identities = await this.db.query<{
      provider: string;
      email: string | null;
      email_verified: boolean;
      created_at: Date | string;
      last_login_at: Date | string | null;
    }>(
      `SELECT provider, email, email_verified, created_at, last_login_at
       FROM external_identities WHERE user_id = $1
       ORDER BY provider`,
      [userId]
    );
    return {
      user: {
        ...summary!,
        external_identities: identities.rows.map((identity) => ({
          provider: identity.provider,
          email: identity.email,
          email_verified: identity.email_verified,
          created_at: iso(identity.created_at),
          last_login_at: nullableIso(identity.last_login_at)
        }))
      }
    };
  }

  async suspendUser(reference: string, mutation: OperatorMutation) {
    return this.withUserMutation(
      "user.suspend",
      reference,
      mutation,
      async (connection, user) => {
        const revoked = await this.revokeCredentials(connection, user.id);
        const changed = user.suspended_at === null;
        await connection.query(
          `UPDATE users SET suspended_at = COALESCE(suspended_at, now()),
             session_epoch = session_epoch + 1
           WHERE id = $1`,
          [user.id]
        );
        await audit(connection, user.id, "account.suspended", user.id, {
          actor: mutation.actor,
          reason: mutation.reason,
          operation_id: mutation.operationId,
          changed,
          revoked
        });
        return {
          operation_id: mutation.operationId,
          user_id: user.id,
          status: "suspended" as const,
          changed,
          revoked
        };
      }
    );
  }

  async restoreUser(reference: string, mutation: OperatorMutation) {
    return this.withUserMutation(
      "user.restore",
      reference,
      mutation,
      async (connection, user) => {
        const changed = user.suspended_at !== null;
        const revoked = changed
          ? await this.revokeCredentials(connection, user.id)
          : null;
        if (changed) {
          await connection.query(
            `UPDATE users SET suspended_at = NULL,
               session_epoch = session_epoch + 1
             WHERE id = $1`,
            [user.id]
          );
        }
        await audit(connection, user.id, "account.restored", user.id, {
          actor: mutation.actor,
          reason: mutation.reason,
          operation_id: mutation.operationId,
          changed,
          credentials_restored: false,
          ...(revoked ? { revoked } : {})
        });
        return {
          operation_id: mutation.operationId,
          user_id: user.id,
          status: "active" as const,
          changed,
          credentials_restored: false,
          ...(revoked ? { revoked } : {})
        };
      }
    );
  }

  async revokeUserSessions(reference: string, mutation: OperatorMutation) {
    return this.withUserMutation(
      "user.revoke_sessions",
      reference,
      mutation,
      async (connection, user) => {
        const sessions = await connection.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [user.id]
        );
        await connection.query(
          "UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1",
          [user.id]
        );
        const revokedSessions = affected(sessions);
        await audit(connection, user.id, "account.sessions_revoked", user.id, {
          actor: mutation.actor,
          reason: mutation.reason,
          operation_id: mutation.operationId,
          revoked_sessions: revokedSessions
        });
        return {
          operation_id: mutation.operationId,
          user_id: user.id,
          revoked_sessions: revokedSessions
        };
      }
    );
  }

  async listInvitations(input: InvitationPageInput = {}) {
    const limit = pageSize(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (input.status) conditions.push(invitationStatusCondition(input.status));
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(created_at < $${values.length - 1}
          OR (created_at = $${values.length - 1} AND id < $${values.length}))`
      );
    }
    values.push(limit + 1);
    const result = await this.db.query<InvitationRow>(
      `SELECT id, email, created_by, expires_at, accepted_at, revoked_at,
              revoked_by, revocation_reason, send_count, last_sent_at,
              created_at
       FROM invitations
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values
    );
    const rows = result.rows.slice(0, limit);
    return {
      invitations: rows.map(invitationSummary),
      next_cursor: result.rows.length > limit && rows.length
        ? encodeCursor(rows[rows.length - 1]!.created_at, rows[rows.length - 1]!.id)
        : null
    };
  }

  async showInvitation(invitationId: string) {
    requireUuid(invitationId, "Invitation ID");
    const result = await this.db.query<InvitationRow>(
      `SELECT id, email, created_by, expires_at, accepted_at, revoked_at,
              revoked_by, revocation_reason, send_count, last_sent_at,
              created_at
       FROM invitations WHERE id = $1`,
      [invitationId]
    );
    if (!result.rows[0]) {
      throw new InstanceAdminNotFoundError("Invitation was not found.");
    }
    return { invitation: invitationSummary(result.rows[0]) };
  }

  async listBetaAccessRequests(input: BetaAccessRequestPageInput = {}) {
    const limit = pageSize(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (input.status === "pending") conditions.push("invited_at IS NULL");
    if (input.status === "invited") conditions.push("invited_at IS NOT NULL");
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(requested_at < $${values.length - 1}
          OR (requested_at = $${values.length - 1} AND id < $${values.length}))`
      );
    }
    values.push(limit + 1);
    const result = await this.db.query<BetaAccessRequestRow>(
      `SELECT id, email, invitation_id, invited_at, requested_at
       FROM beta_access_requests
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY requested_at DESC, id DESC
       LIMIT $${values.length}`,
      values
    );
    const rows = result.rows.slice(0, limit);
    return {
      requests: rows.map((row) => ({
        id: row.id,
        email: row.email,
        status: row.invited_at ? "invited" as const : "pending" as const,
        requested_at: iso(row.requested_at),
        invited_at: nullableIso(row.invited_at),
        invitation_id: row.invitation_id
      })),
      next_cursor: result.rows.length > limit && rows.length
        ? encodeCursor(
            rows[rows.length - 1]!.requested_at,
            rows[rows.length - 1]!.id
          )
        : null
    };
  }

  async revokeInvitation(invitationId: string, mutation: OperatorMutation) {
    requireUuid(invitationId, "Invitation ID");
    const normalized = normalizeMutation(mutation);
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const existing = await reserveOperation(
        connection,
        normalized,
        "invitation.revoke",
        "invitation",
        invitationId
      );
      if (existing !== null) {
        await connection.query("COMMIT");
        return existing;
      }
      const invitation = await connection.query<InvitationRow>(
        `SELECT id, email, created_by, expires_at, accepted_at, revoked_at,
                revoked_by, revocation_reason, send_count, last_sent_at,
                created_at
         FROM invitations WHERE id = $1 FOR UPDATE`,
        [invitationId]
      );
      const row = invitation.rows[0];
      if (!row) {
        throw new InstanceAdminNotFoundError("Invitation was not found.");
      }
      if (row.accepted_at) {
        throw new InstanceAdminConflictError(
          "An accepted invitation cannot be revoked."
        );
      }
      const changed = row.revoked_at === null;
      if (changed) {
        await connection.query(
          `UPDATE invitations SET revoked_at = now(), revoked_by = $2,
             revocation_reason = $3 WHERE id = $1`,
          [invitationId, normalized.actor, normalized.reason]
        );
      }
      await audit(connection, null, "invitation.revoked", invitationId, {
        actor: normalized.actor,
        reason: normalized.reason,
        operation_id: normalized.operationId,
        changed
      });
      const output = {
        operation_id: normalized.operationId,
        invitation_id: invitationId,
        status: "revoked" as const,
        changed
      };
      await completeOperation(
        connection,
        normalized,
        "invitation.revoke",
        "invitation",
        invitationId,
        output
      );
      await connection.query("COMMIT");
      return output;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  async listAuditEvents(input: AuditPageInput = {}) {
    const limit = pageSize(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (input.userId) {
      requireUuid(input.userId, "User ID");
      values.push(input.userId);
      conditions.push(`user_id = $${values.length}`);
    }
    if (input.eventType) {
      values.push(requiredText(input.eventType, 200, "Event type"));
      conditions.push(`event_type = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(
        `(created_at < $${values.length - 1}
          OR (created_at = $${values.length - 1} AND id < $${values.length}))`
      );
    }
    values.push(limit + 1);
    const result = await this.db.query<AuditRow>(
      `SELECT id, user_id, event_type, subject_id, metadata, created_at
       FROM audit_events
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values
    );
    const rows = result.rows.slice(0, limit);
    return {
      events: rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        event_type: row.event_type,
        subject_id: row.subject_id,
        metadata: row.metadata,
        created_at: iso(row.created_at)
      })),
      next_cursor: result.rows.length > limit && rows.length
        ? encodeCursor(rows[rows.length - 1]!.created_at, rows[rows.length - 1]!.id)
        : null
    };
  }

  private async revokeCredentials(
    connection: DatabaseConnection,
    userId: string
  ) {
    const replicas = await connection.query<{ id: string }>(
      `SELECT r.id
       FROM hosted_replicas r
       JOIN hosted_collections c ON c.id = r.collection_id
       WHERE c.user_id = $1 AND r.revoked_at IS NULL`,
      [userId]
    );
    const authorityImports = await connection.query<{ id: string }>(
      `SELECT id FROM authority_adoption_requests
       WHERE user_id = $1 AND revoked_at IS NULL
         AND state IN ('approved', 'prepared')`,
      [userId]
    );
    if (replicas.rows.length && !this.hostedReplicaRevoker) {
      throw new InstanceAdminConflictError(
        "Hosted replica revocation is unavailable; account state was not changed."
      );
    }
    if (
      authorityImports.rows.length
      && !this.hostedReplicaRevoker?.abortAuthorityImport
    ) {
      throw new InstanceAdminConflictError(
        "Hosted authority-import revocation is unavailable; account state was not changed."
      );
    }
    for (const replica of replicas.rows) {
      await this.hostedReplicaRevoker!.revokeReplica(replica.id);
    }
    for (const authorityImport of authorityImports.rows) {
      await this.hostedReplicaRevoker!.abortAuthorityImport!(
        authorityImport.id
      );
    }

    const sessions = await connection.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    const connectors = await connection.query(
      `UPDATE connectors SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    const pairingRequests = await connection.query(
      `UPDATE pairing_requests
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    const mirrorPairings = await connection.query(
      `UPDATE mirror_pairing_requests
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    const authorityAdoptions = await connection.query(
      `UPDATE authority_adoption_requests
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL
         AND state <> 'completed'`,
      [userId]
    );
    const grants = await connection.query(
      `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
    const accessTokens = await connection.query(
      `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE revoked_at IS NULL
         AND grant_id IN (SELECT id FROM grants WHERE user_id = $1)`,
      [userId]
    );
    const refreshTokens = await connection.query(
      `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
       WHERE revoked_at IS NULL
         AND grant_id IN (SELECT id FROM grants WHERE user_id = $1)`,
      [userId]
    );
    const channels = await connection.query(
      `UPDATE push_channels SET disabled_at = COALESCE(disabled_at, now()),
         updated_at = now()
       WHERE disabled_at IS NULL
         AND grant_id IN (SELECT id FROM grants WHERE user_id = $1)`,
      [userId]
    );
    await connection.query(
      `UPDATE hosted_replicas SET revoked_at = COALESCE(revoked_at, now()),
         token_hash = NULL
       WHERE collection_id IN (
         SELECT id FROM hosted_collections WHERE user_id = $1
       )`,
      [userId]
    );
    return {
      sessions: affected(sessions),
      connectors: affected(connectors),
      pairing_requests: affected(pairingRequests),
      mirror_pairing_credentials: affected(mirrorPairings),
      authority_adoption_credentials: affected(authorityAdoptions),
      grants: affected(grants),
      access_tokens: affected(accessTokens),
      refresh_tokens: affected(refreshTokens),
      notification_channels: affected(channels),
      hosted_replicas: replicas.rows.length,
      hosted_authority_imports: authorityImports.rows.length
    };
  }

  private async withUserMutation<T>(
    action: string,
    reference: string,
    mutation: OperatorMutation,
    change: (
      connection: DatabaseConnection,
      user: { id: string; suspended_at: Date | string | null }
    ) => Promise<T>
  ): Promise<T> {
    const normalized = normalizeMutation(mutation);
    const userId = await resolveUserId(this.db, reference);
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const existing = await reserveOperation(
        connection,
        normalized,
        action,
        "user",
        userId
      );
      if (existing !== null) {
        await connection.query("COMMIT");
        return existing as T;
      }
      const user = await connection.query<{
        id: string;
        suspended_at: Date | string | null;
      }>(
        "SELECT id, suspended_at FROM users WHERE id = $1 FOR UPDATE",
        [userId]
      );
      if (!user.rows[0]) {
        throw new InstanceAdminNotFoundError("User was not found.");
      }
      const output = await change(connection, user.rows[0]);
      await completeOperation(
        connection,
        normalized,
        action,
        "user",
        userId,
        output
      );
      await connection.query("COMMIT");
      return output;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function resolveUserId(
  db: DatabaseQueryable,
  reference: string
): Promise<string> {
  const trimmed = reference.trim();
  let result;
  if (UUID_PATTERN.test(trimmed)) {
    result = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE id = $1",
      [trimmed]
    );
  } else {
    const normalized = normalizeEmailAddress(trimmed);
    result = await db.query<{ id: string }>(
      `SELECT user_id AS id FROM email_identities
       WHERE normalized_email = $1 AND retired_at IS NULL
       UNION
       SELECT user_id AS id FROM external_identities
       WHERE normalized_email = $1 AND email_verified = true
       UNION
       SELECT id FROM users
       WHERE email IS NOT NULL AND lower(email) = lower($1)
       LIMIT 2`,
      [normalized]
    );
  }
  if (result.rows.length === 0) {
    throw new InstanceAdminNotFoundError("User was not found.");
  }
  if (result.rows.length > 1) {
    throw new InstanceAdminConflictError(
      "The user reference matches more than one account."
    );
  }
  return result.rows[0]!.id;
}

async function hydrateUsers(
  db: DatabaseQueryable,
  rows: UserSummaryRow[]
) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
  const [
    primaryEmails,
    externalEmails,
    sessions,
    connectors,
    grants,
    hostedCollections
  ] = await Promise.all([
    db.query<{ user_id: string; email: string }>(
      `SELECT user_id, email FROM email_identities
       WHERE user_id IN (${placeholders}) AND is_primary = true
         AND retired_at IS NULL`,
      ids
    ),
    db.query<{ user_id: string; email: string; provider: string }>(
      `SELECT user_id, email, provider FROM external_identities
       WHERE user_id IN (${placeholders}) AND email_verified = true
         AND email IS NOT NULL
       ORDER BY provider`,
      ids
    ),
    countByUser(
      db,
      `SELECT user_id, count(*) AS count FROM sessions
       WHERE user_id IN (${placeholders}) AND revoked_at IS NULL
         AND expires_at > now() GROUP BY user_id`,
      ids
    ),
    countByUser(
      db,
      `SELECT user_id, count(*) AS count FROM connectors
       WHERE user_id IN (${placeholders}) AND revoked_at IS NULL
       GROUP BY user_id`,
      ids
    ),
    countByUser(
      db,
      `SELECT user_id, count(*) AS count FROM grants
       WHERE user_id IN (${placeholders}) AND revoked_at IS NULL
         AND activated_at IS NOT NULL GROUP BY user_id`,
      ids
    ),
    countByUser(
      db,
      `SELECT user_id, count(*) AS count FROM hosted_collections
       WHERE user_id IN (${placeholders}) GROUP BY user_id`,
      ids
    )
  ]);
  const emails = new Map(
    primaryEmails.rows.map((identity) => [identity.user_id, identity.email])
  );
  for (const identity of externalEmails.rows) {
    if (!emails.has(identity.user_id)) {
      emails.set(identity.user_id, identity.email);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    email: emails.get(row.id) ?? row.email,
    name: row.name,
    status: row.suspended_at ? "suspended" as const : "active" as const,
    suspended_at: nullableIso(row.suspended_at),
    created_at: iso(row.created_at),
    active_sessions: sessions.get(row.id) ?? 0,
    active_connectors: connectors.get(row.id) ?? 0,
    active_grants: grants.get(row.id) ?? 0,
    hosted_collections: hostedCollections.get(row.id) ?? 0
  }));
}

async function countByUser(
  db: DatabaseQueryable,
  query: string,
  values: string[]
): Promise<Map<string, number>> {
  const result = await db.query<{ user_id: string; count: string | number }>(
    query,
    values
  );
  return new Map(
    result.rows.map((row) => [row.user_id, Number(row.count)])
  );
}

function invitationSummary(row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    status: invitationStatus(row),
    created_by: row.created_by,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    accepted_at: nullableIso(row.accepted_at),
    revoked_at: nullableIso(row.revoked_at),
    revoked_by: row.revoked_by,
    revocation_reason: row.revocation_reason,
    send_count: Number(row.send_count),
    last_sent_at: nullableIso(row.last_sent_at)
  };
}

function invitationStatus(
  row: Pick<InvitationRow, "accepted_at" | "revoked_at" | "expires_at">
): "active" | "accepted" | "revoked" | "expired" {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (new Date(row.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

function invitationStatusCondition(
  status: NonNullable<InvitationPageInput["status"]>
): string {
  if (status === "accepted") return "accepted_at IS NOT NULL";
  if (status === "revoked") {
    return "accepted_at IS NULL AND revoked_at IS NOT NULL";
  }
  if (status === "expired") {
    return "accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()";
  }
  return "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()";
}

function pageSize(value: number | undefined): number {
  const size = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new TypeError(`Page size must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  return size;
}

function encodeCursor(createdAt: Date | string, id: string): string {
  return Buffer.from(JSON.stringify({
    createdAt: iso(createdAt),
    id
  })).toString("base64url");
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as { createdAt?: unknown; id?: unknown };
    if (
      typeof decoded.createdAt !== "string"
      || !Number.isFinite(Date.parse(decoded.createdAt))
      || typeof decoded.id !== "string"
      || !UUID_PATTERN.test(decoded.id)
    ) {
      throw new Error("invalid");
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new TypeError("Cursor is invalid.");
  }
}

function normalizeMutation(mutation: OperatorMutation): OperatorMutation {
  return {
    operationId: requireUuid(mutation.operationId, "Operation ID"),
    actor: requiredText(mutation.actor, 200, "Operator actor"),
    reason: requiredText(mutation.reason, 500, "Operator reason")
  };
}

async function reserveOperation(
  db: DatabaseQueryable,
  mutation: OperatorMutation,
  action: string,
  targetType: string,
  targetId: string
): Promise<unknown | null> {
  await db.query(
    "SELECT pg_advisory_xact_lock($1, $2)",
    operationLockParts(mutation.operationId)
  );
  const existing = await db.query<StoredOperationRow>(
    `SELECT action, target_type, target_id, actor, reason, result
     FROM operator_operations WHERE operation_id = $1`,
    [mutation.operationId]
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (
    row.action !== action
    || row.target_type !== targetType
    || row.target_id !== targetId
    || row.actor !== mutation.actor
    || row.reason !== mutation.reason
  ) {
    throw new InstanceAdminConflictError(
      "Operation ID was already used for a different request."
    );
  }
  return row.result;
}

async function completeOperation(
  db: DatabaseQueryable,
  mutation: OperatorMutation,
  action: string,
  targetType: string,
  targetId: string,
  result: unknown
): Promise<void> {
  const inserted = await db.query(
    `INSERT INTO operator_operations
       (operation_id, action, target_type, target_id, actor, reason, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      mutation.operationId,
      action,
      targetType,
      targetId,
      mutation.actor,
      mutation.reason,
      JSON.stringify(result)
    ]
  );
  if (affected(inserted) !== 1) {
    throw new Error("Operator operation could not be recorded.");
  }
}

function operationLockParts(operationId: string): [number, number] {
  const hex = operationId.replaceAll("-", "");
  return [
    Number.parseInt(hex.slice(0, 8), 16) | 0,
    Number.parseInt(hex.slice(8, 16), 16) | 0
  ];
}

async function audit(
  db: DatabaseQueryable,
  userId: string | null,
  eventType: string,
  subjectId: string | null,
  metadata: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), userId, eventType, subjectId, JSON.stringify(metadata)]
  );
}

function affected(result: { rowCount: number | null; rows: unknown[] }): number {
  return result.rowCount ?? result.rows.length;
}

function requireUuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a UUID.`);
  }
  return normalized;
}

function requiredText(value: string, maxLength: number, name: string): string {
  const normalized = value.trim().normalize("NFC");
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(
      `${name} must contain between 1 and ${maxLength} characters.`
    );
  }
  return normalized;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}
