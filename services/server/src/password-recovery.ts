import { randomUUID } from "node:crypto";
import type {
  DatabasePool,
  DatabaseQueryable
} from "./db.js";
import { normalizeEmailAddress } from "./email-identity.js";
import {
  AuthenticationPolicyStore,
  type AuthenticationSettings
} from "./authentication-policy.js";
import { hashPassword } from "./password.js";
import { randomToken, tokenHash } from "./security.js";

const PASSWORD_RESET_LIFETIME_SECONDS = 60 * 60;

export interface CreatedPasswordReset {
  challengeId: string;
  userId: string;
  email: string;
  token: string;
  expiresAt: Date;
}

export interface CompletePasswordResetInput {
  token: string;
  password: string;
  clientName: string;
}

export interface RecoveredPasswordSession {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
}

export type PasswordResetDeliveryOutcome =
  | {
      status: "sent";
      provider: string;
      messageId: string;
    }
  | {
      status: "failed";
      provider: string;
      code: string;
      retryable: boolean;
    };

interface PasswordResetChallengeRow {
  id: string;
  user_id: string;
  normalized_email: string;
}

interface PasswordResetAccountRow {
  user_id: string;
  email: string;
  name: string;
}

export class InvalidPasswordResetError extends Error {
  constructor() {
    super("Password reset is invalid or expired.");
    this.name = "InvalidPasswordResetError";
  }
}

export class PasswordRecoveryUnavailableError extends Error {
  constructor() {
    super("Password recovery is unavailable.");
    this.name = "PasswordRecoveryUnavailableError";
  }
}

export class PasswordRecoveryService {
  constructor(
    private readonly db: DatabasePool,
    private readonly policy: AuthenticationPolicyStore
  ) {}

  async create(emailInput: string): Promise<CreatedPasswordReset | null> {
    const normalizedEmail = normalizeEmailAddress(emailInput);
    const token = randomToken("rst");
    const challengeId = randomUUID();
    const expiresAt = new Date(
      Date.now() + PASSWORD_RESET_LIFETIME_SECONDS * 1_000
    );
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      requireRecoveryRequestsEnabled(
        await this.policy.currentForAccountChange(connection)
      );
      const account = await connection.query<PasswordResetAccountRow>(
        `SELECT u.id AS user_id, e.email, u.name
         FROM email_identities e
         JOIN users u ON u.id = e.user_id
         JOIN password_credentials p ON p.user_id = u.id
         WHERE e.normalized_email = $1
           AND e.retired_at IS NULL
           AND e.verified_at IS NOT NULL
           AND u.suspended_at IS NULL
         FOR UPDATE`,
        [normalizedEmail]
      );
      const row = account.rows[0];
      if (!row) {
        await connection.query("COMMIT");
        return null;
      }
      await connection.query(
        `UPDATE authentication_challenges SET invalidated_at = now()
         WHERE purpose = 'password_reset'
           AND normalized_email = $1
           AND consumed_at IS NULL
           AND invalidated_at IS NULL`,
        [normalizedEmail]
      );
      await connection.query(
        `INSERT INTO authentication_challenges
           (id, purpose, token_hash, normalized_email, user_id,
            expires_at, max_attempts)
         VALUES ($1, 'password_reset', $2, $3, $4, $5, 1)`,
        [
          challengeId,
          tokenHash(token),
          normalizedEmail,
          row.user_id,
          expiresAt
        ]
      );
      await audit(
        connection,
        row.user_id,
        "password_reset.requested",
        challengeId,
        {}
      );
      await connection.query("COMMIT");
      return {
        challengeId,
        userId: row.user_id,
        email: row.email,
        token,
        expiresAt
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordDelivery(
    challengeId: string,
    userId: string,
    outcome: PasswordResetDeliveryOutcome
  ): Promise<void> {
    await audit(
      this.db,
      userId,
      outcome.status === "sent"
        ? "password_reset.sent"
        : "password_reset.delivery_failed",
      challengeId,
      outcome.status === "sent"
        ? {
            provider: outcome.provider,
            message_id: outcome.messageId
          }
        : {
            provider: outcome.provider,
            code: outcome.code,
            retryable: outcome.retryable
          }
    );
  }

  async complete(
    input: CompletePasswordResetInput
  ): Promise<RecoveredPasswordSession> {
    if (input.token.length > 200) throw new InvalidPasswordResetError();
    requirePasswordResetEnabled(await this.policy.current());
    const challengeHash = tokenHash(input.token);
    const preliminary = await this.db.query<PasswordResetChallengeRow>(
      `SELECT id, user_id, normalized_email
       FROM authentication_challenges
       WHERE purpose = 'password_reset'
         AND token_hash = $1
         AND consumed_at IS NULL
         AND invalidated_at IS NULL
         AND attempt_count < max_attempts
         AND expires_at > now()`,
      [challengeHash]
    );
    if (!preliminary.rows[0]) throw new InvalidPasswordResetError();
    const passwordHash = await hashPassword(input.password);
    const sessionId = randomUUID();
    const sessionToken = randomToken("ses");
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      requirePasswordResetEnabled(
        await this.policy.currentForAccountChange(connection)
      );
      const consumed = await connection.query<PasswordResetChallengeRow>(
        `UPDATE authentication_challenges SET
           consumed_at = now(),
           attempt_count = attempt_count + 1
         WHERE purpose = 'password_reset'
           AND token_hash = $1
           AND consumed_at IS NULL
           AND invalidated_at IS NULL
           AND attempt_count < max_attempts
           AND expires_at > now()
         RETURNING id, user_id, normalized_email`,
        [challengeHash]
      );
      const challenge = consumed.rows[0];
      if (!challenge) throw new InvalidPasswordResetError();
      const account = await connection.query<PasswordResetAccountRow>(
        `SELECT u.id AS user_id, e.email, u.name
         FROM users u
         JOIN email_identities e ON e.user_id = u.id
         JOIN password_credentials p ON p.user_id = u.id
         WHERE u.id = $1
           AND e.normalized_email = $2
           AND e.retired_at IS NULL
           AND e.verified_at IS NOT NULL
           AND u.suspended_at IS NULL
         FOR UPDATE`,
        [challenge.user_id, challenge.normalized_email]
      );
      const active = account.rows[0];
      if (!active) throw new InvalidPasswordResetError();
      await connection.query(
        `UPDATE password_credentials SET
           password_hash = $2,
           credential_version = credential_version + 1,
           updated_at = now()
         WHERE user_id = $1`,
        [active.user_id, passwordHash]
      );
      const accountEpoch = await connection.query<{ session_epoch: string | number }>(
        `UPDATE users SET session_epoch = session_epoch + 1
         WHERE id = $1
         RETURNING session_epoch`,
        [active.user_id]
      );
      const revoked = await connection.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [active.user_id]
      );
      await connection.query(
        `UPDATE authentication_challenges SET invalidated_at = now()
         WHERE purpose = 'password_reset'
           AND user_id = $1
           AND id <> $2
           AND consumed_at IS NULL
           AND invalidated_at IS NULL`,
        [active.user_id, challenge.id]
      );
      await connection.query(
        `INSERT INTO sessions
           (id, user_id, token_hash, provider, account_session_epoch,
            expires_at, client_name)
         VALUES ($1, $2, $3, 'password', $4,
                 now() + interval '30 days', $5)`,
        [
          sessionId,
          active.user_id,
          tokenHash(sessionToken),
          accountEpoch.rows[0]!.session_epoch,
          input.clientName
        ]
      );
      await audit(
        connection,
        active.user_id,
        "credential.password_reset",
        challenge.id,
        {}
      );
      await audit(
        connection,
        active.user_id,
        "session.revoked_all",
        challenge.id,
        { revoked_count: revoked.rows.length }
      );
      await audit(
        connection,
        active.user_id,
        "session.created",
        sessionId,
        { provider: "password", source: "password_reset" }
      );
      await connection.query("COMMIT");
      return {
        token: sessionToken,
        user: {
          id: active.user_id,
          email: active.email,
          name: active.name
        }
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}

function requireRecoveryRequestsEnabled(settings: AuthenticationSettings): void {
  if (!settings.passwordAuthEnabled || !settings.emailDeliveryEnabled) {
    throw new PasswordRecoveryUnavailableError();
  }
}

function requirePasswordResetEnabled(settings: AuthenticationSettings): void {
  if (!settings.passwordAuthEnabled) {
    throw new PasswordRecoveryUnavailableError();
  }
}

async function audit(
  db: DatabaseQueryable,
  userId: string,
  eventType: string,
  subjectId: string,
  metadata: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), userId, eventType, subjectId, JSON.stringify(metadata)]
  );
}
