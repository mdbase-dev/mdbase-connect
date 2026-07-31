import { randomUUID } from "node:crypto";
import type {
  DatabasePool,
  DatabaseQueryable
} from "./database-types.js";
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
