import { randomUUID } from "node:crypto";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryable
} from "./database-types.js";
import { queueAccountProviderCleanup } from "./hosted-capability-lifecycle.js";
import type {
  ExternalProvider,
  VerifiedExternalIdentity
} from "./external-auth.js";
import {
  EMAIL_NORMALIZATION_VERSION,
  normalizeEmailAddress
} from "./email-identity.js";
import { audit } from "./platform/audit-events.js";
import { randomToken, tokenHash } from "./security.js";

export class ExternalIdentityConflictError extends Error {
  constructor() {
    super("That sign-in identity is already attached to another account.");
    this.name = "ExternalIdentityConflictError";
  }
}

export class IdentityRemovalForbiddenError extends Error {
  constructor(public readonly code: "current_identity" | "last_identity") {
    super(code === "current_identity"
      ? "Sign in with another method before disconnecting the one used by this session."
      : "Connect another sign-in method before disconnecting this one.");
    this.name = "IdentityRemovalForbiddenError";
  }
}

export class AccountDeletionAuthorizationError extends Error {
  constructor() {
    super("Confirm your identity again before deleting this account.");
    this.name = "AccountDeletionAuthorizationError";
  }
}

export interface AccountSignInMethodCounts {
  external: number;
  password: boolean;
}

export interface AccountDeletionResult {
  hostedCollectionsScheduledForDeletion: number;
  crossAccountReplicasRevoked: number;
  localCollectionsPreserved: number;
}

export async function deleteAccountLocally(
  db: DatabasePool,
  input: {
    userId: string;
    sessionId: string;
    authorized: boolean;
    reauthToken?: string;
    queueProviderCleanup: boolean;
  }
): Promise<AccountDeletionResult> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '5s'");
    const locked = await connection.query(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [input.userId]
    );
    if (!locked.rows[0]) throw new AccountDeletionAuthorizationError();

    let authorized = input.authorized;
    if (!authorized && input.reauthToken) {
      authorized = await consumeAccountActionToken(
        connection,
        input.userId,
        input.sessionId,
        "delete_account",
        input.reauthToken
      );
    }
    if (!authorized) throw new AccountDeletionAuthorizationError();

    const member = (await connection.query<{ cohort: string }>(
      "SELECT cohort FROM next_migration_cohort_members WHERE account_id=$1 FOR SHARE", [input.userId]
    )).rows[0];
    const batch = member ? (await connection.query<{ frozen_at: Date | null; revision: string }>(
      "SELECT frozen_at,membership_revision::text AS revision FROM next_migration_cohorts WHERE name=$1 FOR UPDATE", [member.cohort]
    )).rows[0] : undefined;
    if (member && !batch) throw new Error("Migration membership has no cohort.");
    if (batch && batch.frozen_at !== null) {
      // Acceptance, credential revocation and the durable request commit together.
      // Keep archived topology intact; never queue provider erasure before ready.
      await connection.query(
        `INSERT INTO next_migration_deferred_account_deletions
           (account_id,cohort,membership_revision,frozen_at,queue_provider_cleanup)
         VALUES($1,$2,$3::bigint,$4,$5) ON CONFLICT(account_id) DO NOTHING`,
        [input.userId, member!.cohort, batch.revision, batch.frozen_at, input.queueProviderCleanup]
      );
      await connection.query("UPDATE users SET suspended_at=COALESCE(suspended_at,now()),session_epoch=session_epoch+1 WHERE id=$1", [input.userId]);
      await connection.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [input.userId]);
      await connection.query("UPDATE connectors SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [input.userId]);
      await connection.query("UPDATE grants SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [input.userId]);
      await connection.query(
        `UPDATE hosted_replicas SET token_hash=NULL
         WHERE authorized_user_id=$1 OR collection_id IN (SELECT id FROM hosted_collections WHERE user_id=$1)`, [input.userId]
      );
      const result = await accountDeletionCounts(connection, input.userId);
      await audit(connection, input.userId, "account.deletion_accepted", input.userId,
        { deferred: true, cohort: member!.cohort, membership_revision: batch.revision });
      await connection.query("COMMIT");
      return result;
    }
    const result = await eraseAccount(connection, input.userId, input.queueProviderCleanup);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

/** The same erasure pipeline serves immediate requests and durable accepted work. */
async function eraseAccount(client: DatabaseConnection, user: string, queueProvider: boolean): Promise<AccountDeletionResult> {
  const counts = await accountDeletionCounts(client, user);
  const cleanup = queueProvider ? await queueAccountProviderCleanup(client, user) : undefined;
  const result = { ...counts, hostedCollectionsScheduledForDeletion: cleanup?.hostedCollections ?? counts.hostedCollectionsScheduledForDeletion,
    crossAccountReplicasRevoked: cleanup?.crossAccountReplicas ?? 0 };
  await audit(client, user, "account.deleted", user, {
    hosted_collections_scheduled_for_deletion: result.hostedCollectionsScheduledForDeletion,
    cross_account_replicas_revoked: result.crossAccountReplicasRevoked,
    local_collections_preserved: result.localCollectionsPreserved
  });
  await client.query("DELETE FROM users WHERE id=$1", [user]);
  return result;
}

async function accountDeletionCounts(client: DatabaseConnection, user: string): Promise<AccountDeletionResult> {
  const hosted = (await client.query<{ count: string }>("SELECT count(*)::text AS count FROM hosted_collections WHERE user_id=$1", [user])).rows[0];
  const local = (await client.query<{ count: string }>("SELECT count(*)::text AS count FROM collections WHERE user_id=$1 AND present=true", [user])).rows[0];
  return { hostedCollectionsScheduledForDeletion: Number(hosted?.count ?? 0), crossAccountReplicasRevoked: 0, localCollectionsPreserved: Number(local?.count ?? 0) };
}

/** Restart-safe, idempotent drain: readiness was committed under the batch lock. */
export async function drainDeferredAccountDeletions(db: DatabasePool, limit = 25): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Bounded deletion drain required.");
  const candidates = (await db.query<{ account_id: string }>(
    "SELECT account_id FROM next_migration_deferred_account_deletions WHERE ready_at IS NOT NULL ORDER BY requested_at,account_id LIMIT $1", [limit]
  )).rows;
  let completed = 0;
  for (const { account_id: user } of candidates) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      const exists = (await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user])).rows.length;
      const work = (await client.query<{ cohort: string; queue_provider_cleanup: boolean; ready_at: Date | null; ready_revision: string | null }>(
        "SELECT cohort,queue_provider_cleanup,ready_at,ready_revision::text FROM next_migration_deferred_account_deletions WHERE account_id=$1 FOR UPDATE", [user]
      )).rows[0];
      if (exists && work?.ready_at && work.ready_revision !== null) {
        await client.query("SELECT name FROM next_migration_cohorts WHERE name=$1 FOR UPDATE", [work.cohort]);
        await eraseAccount(client, user, work.queue_provider_cleanup);
        completed += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  return completed;
}

export async function accountSignInMethodCounts(
  db: DatabaseQueryable,
  userId: string
): Promise<AccountSignInMethodCounts> {
  const result = await db.query<{
    external_count: string | number;
    password_configured: boolean;
  }>(
    `SELECT
       (SELECT count(*) FROM external_identities WHERE user_id = $1) AS external_count,
       EXISTS(SELECT 1 FROM password_credentials WHERE user_id = $1) AS password_configured`,
    [userId]
  );
  return {
    external: Number(result.rows[0]?.external_count ?? 0),
    password: result.rows[0]?.password_configured === true
  };
}

export async function linkExternalIdentity(
  db: DatabasePool,
  userId: string,
  identity: VerifiedExternalIdentity
): Promise<void> {
  const normalizedEmail = identity.emailVerified && identity.email
    ? safeNormalizedEmail(identity.email)
    : null;
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const user = await connection.query(
      "SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL FOR UPDATE",
      [userId]
    );
    if (!user.rows[0]) throw new ExternalIdentityConflictError();
    const subject = await connection.query<{ user_id: string }>(
      `SELECT user_id FROM external_identities
       WHERE provider = $1 AND subject = $2
       FOR UPDATE`,
      [identity.provider, identity.subject]
    );
    if (subject.rows[0] && subject.rows[0].user_id !== userId) {
      throw new ExternalIdentityConflictError();
    }
    const provider = await connection.query<{ subject: string }>(
      `SELECT subject FROM external_identities
       WHERE provider = $1 AND user_id = $2
       FOR UPDATE`,
      [identity.provider, userId]
    );
    if (provider.rows[0] && provider.rows[0].subject !== identity.subject) {
      throw new ExternalIdentityConflictError();
    }
    await connection.query(
      `INSERT INTO external_identities
         (provider, subject, user_id, login, email, email_verified,
          normalized_email, email_normalization_version, avatar_url, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT(provider, subject) DO UPDATE SET
         login = excluded.login,
         email = excluded.email,
         email_verified = excluded.email_verified,
         normalized_email = excluded.normalized_email,
         email_normalization_version = excluded.email_normalization_version,
         avatar_url = excluded.avatar_url,
         updated_at = now()`,
      [
        identity.provider,
        identity.subject,
        userId,
        identity.login,
        identity.email,
        identity.emailVerified,
        normalizedEmail,
        normalizedEmail ? EMAIL_NORMALIZATION_VERSION : null,
        identity.avatarUrl
      ]
    );
    await audit(connection, userId, "identity.linked", identity.subject, {
      provider: identity.provider
    });
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function safeNormalizedEmail(value: string): string | null {
  try {
    return normalizeEmailAddress(value);
  } catch {
    return null;
  }
}

export async function removeExternalIdentity(
  db: DatabasePool,
  userId: string,
  provider: ExternalProvider,
  currentProvider: string | undefined
): Promise<boolean> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    const identity = await connection.query<{ subject: string }>(
      `SELECT subject FROM external_identities
       WHERE user_id = $1 AND provider = $2
       FOR UPDATE`,
      [userId, provider]
    );
    if (!identity.rows[0]) {
      await connection.query("ROLLBACK");
      return false;
    }
    if (currentProvider === provider) {
      throw new IdentityRemovalForbiddenError("current_identity");
    }
    const methods = await accountSignInMethodCounts(connection, userId);
    if (methods.external + Number(methods.password) <= 1) {
      throw new IdentityRemovalForbiddenError("last_identity");
    }
    await connection.query(
      "DELETE FROM external_identities WHERE user_id = $1 AND provider = $2",
      [userId, provider]
    );
    await connection.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider]
    );
    await audit(connection, userId, "identity.disconnected", identity.rows[0].subject, {
      provider
    });
    await connection.query("COMMIT");
    return true;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function issueAccountActionToken(
  db: DatabasePool,
  userId: string,
  sessionId: string,
  purpose: "delete_account"
): Promise<string> {
  const token = randomToken("act");
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `UPDATE account_action_tokens SET consumed_at = now()
       WHERE user_id = $1 AND session_id = $2 AND purpose = $3
         AND consumed_at IS NULL`,
      [userId, sessionId, purpose]
    );
    await connection.query(
      `INSERT INTO account_action_tokens
         (id, user_id, session_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [randomUUID(), userId, sessionId, purpose, tokenHash(token)]
    );
    await audit(connection, userId, "account.reauthenticated", userId, {
      purpose
    });
    await connection.query("COMMIT");
    return token;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function consumeAccountActionToken(
  db: DatabaseQueryable,
  userId: string,
  sessionId: string,
  purpose: "delete_account",
  token: string
): Promise<boolean> {
  if (!token || token.length > 200) return false;
  const consumed = await db.query(
    `UPDATE account_action_tokens SET consumed_at = now()
     WHERE user_id = $1 AND session_id = $2 AND purpose = $3
       AND token_hash = $4 AND consumed_at IS NULL AND expires_at > now()
     RETURNING id`,
    [userId, sessionId, purpose, tokenHash(token)]
  );
  return Boolean(consumed.rows[0]);
}
