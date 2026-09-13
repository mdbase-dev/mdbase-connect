import { createHash, randomUUID } from "node:crypto";
import {
  accountCreationEmailClaimed,
  reserveAccountCreationEmail
} from "./account-creation-email-claims.js";
import type { DatabasePool, DatabaseQueryable } from "./database-types.js";
import {
  EMAIL_NORMALIZATION_VERSION,
  normalizeEmailAddress
} from "./email-identity.js";
import { randomToken, tokenHash } from "./security.js";

export type ExternalProvider = "github" | "google";

export interface VerifiedExternalIdentity {
  provider: ExternalProvider;
  subject: string;
  name: string;
  login: string | null;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export interface ExternalSession {
  token: string;
  userId: string;
  createdAccount: boolean;
}

export interface CreateExternalSessionOptions {
  clientName?: string;
  allowAccountCreation?: boolean;
}

export class AccountUnavailableError extends Error {
  constructor() {
    super("Account is unavailable.");
    this.name = "AccountUnavailableError";
  }
}

export async function createExternalSession(
  db: DatabasePool,
  identity: VerifiedExternalIdentity,
  options: CreateExternalSessionOptions = {}
): Promise<ExternalSession> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const session = await createExternalSessionInTransaction(connection, identity, options);
    await connection.query("COMMIT");
    return session;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

/** Caller owns the transaction, including any new-account onboarding writes. */
export async function createExternalSessionInTransaction(
  connection: DatabaseQueryable,
  identity: VerifiedExternalIdentity,
  options: CreateExternalSessionOptions = {}
): Promise<ExternalSession> {
  const token = randomToken("ses");
  const normalizedEmail = normalizedVerifiedEmail(identity);
  // Serialize independent proofs of the same subject before deciding whether
  // this is signup or login. Email claims separately serialize different subjects.
  const lock = createHash("sha256").update(`external-identity\0${identity.provider}\0${identity.subject}`).digest();
  await connection.query("SELECT pg_advisory_xact_lock($1, $2)", [lock.readInt32BE(0), lock.readInt32BE(4)]);
  const existing = await connection.query<{ user_id: string }>(
    `SELECT user_id FROM external_identities
     WHERE provider = $1 AND subject = $2`,
    [identity.provider, identity.subject]
  );
  const createdAccount = !existing.rows[0];
  if (createdAccount && options.allowAccountCreation === false) {
    throw new AccountUnavailableError();
  }
  const userId = existing.rows[0]?.user_id ?? externalUserId(identity.provider, identity.subject);
  if (createdAccount) {
    if (normalizedEmail && await accountCreationEmailClaimed(connection, normalizedEmail)) {
      throw new AccountUnavailableError();
    }
    const created = await connection.query(
      `INSERT INTO users (id, email, name) VALUES ($1, NULL, $2)
       ON CONFLICT(id) DO NOTHING RETURNING id`,
      [userId, identity.name]
    );
    // A previously disconnected identity must not reopen its former account.
    if (!created.rows[0]) throw new AccountUnavailableError();
    if (normalizedEmail && !await reserveAccountCreationEmail(connection, {
      normalizedEmail,
      userId,
      source: "external_identity"
    })) {
      throw new AccountUnavailableError();
    }
  }
  const linked = await connection.query(
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
       last_login_at = now(),
       updated_at = now()
     WHERE external_identities.user_id = excluded.user_id
     RETURNING user_id`,
    [
      identity.provider, identity.subject, userId, identity.login, identity.email,
      identity.emailVerified, normalizedEmail,
      normalizedEmail ? EMAIL_NORMALIZATION_VERSION : null, identity.avatarUrl
    ]
  );
  if (!linked.rows[0]) throw new AccountUnavailableError();
  await connection.query("DELETE FROM sessions WHERE expires_at <= now()");
  const createdSession = await connection.query(
    `INSERT INTO sessions
       (id, user_id, token_hash, provider, account_session_epoch,
        expires_at, client_name)
     SELECT $1, id, $3, $4, session_epoch,
            now() + interval '30 days', $5
     FROM users WHERE id = $2 AND suspended_at IS NULL
     RETURNING id`,
    [randomUUID(), userId, tokenHash(token), identity.provider, options.clientName ?? null]
  );
  if (!createdSession.rows[0]) throw new AccountUnavailableError();
  await connection.query(
    `INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, 'session.created', NULL, $3::jsonb)`,
    [randomUUID(), userId, JSON.stringify({ provider: identity.provider })]
  );
  return { token, userId, createdAccount };
}

function normalizedVerifiedEmail(identity: VerifiedExternalIdentity): string | null {
  if (!identity.emailVerified || !identity.email) return null;
  try {
    return normalizeEmailAddress(identity.email);
  } catch {
    return null;
  }
}

export function externalUserId(provider: string, subject: string): string {
  const bytes = createHash("sha256").update(`${provider}\0${subject}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
