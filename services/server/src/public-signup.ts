import { randomUUID } from "node:crypto";
import {
  accountCreationEmailClaimed,
  reserveAccountCreationEmail
} from "./account-creation-email-claims.js";
import type { DatabasePool, DatabaseQueryable } from "./database-types.js";
import {
  EMAIL_NORMALIZATION_VERSION,
  normalizeEmailAddress
} from "./email-identity.js";
import {
  AuthenticationPolicyStore,
  type AuthenticationSettings
} from "./authentication-policy.js";
import { scheduleStarterCollection } from "./account-onboarding.js";
import { scheduleOpenBetaWelcomeEmail } from "./beta-welcome-email.js";
import { materializePublicSignupEntitlement } from "./entitlements.js";
import { hashPassword } from "./password.js";
import { randomToken, tokenHash } from "./security.js";

const PUBLIC_SIGNUP_LIFETIME_SECONDS = 60 * 60;

export interface CreatedPublicSignupVerification {
  challengeId: string;
  email: string;
  token: string;
  expiresAt: Date;
}

export interface PublicSignupVerificationDetails {
  email: string;
  expiresAt: Date;
}

export interface CompletePublicSignupInput {
  verificationToken: string;
  name: string;
  password: string;
  termsVersion: string;
  privacyVersion: string;
  timezone?: string;
  clientName?: string;
}

export type PublicSignupDeliveryOutcome =
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

interface PublicSignupChallengeRow {
  id: string;
  normalized_email: string;
  expires_at: Date | string;
}

export class PublicSignupUnavailableError extends Error {
  constructor() {
    super("Public password signup is unavailable.");
    this.name = "PublicSignupUnavailableError";
  }
}

export class InvalidPublicSignupVerificationError extends Error {
  constructor() {
    super("Email verification is invalid or expired.");
    this.name = "InvalidPublicSignupVerificationError";
  }
}

export class PublicSignupService {
  constructor(
    private readonly db: DatabasePool,
    private readonly policy: AuthenticationPolicyStore
  ) {}

  async create(
    emailInput: string
  ): Promise<CreatedPublicSignupVerification | null> {
    const email = normalizeEmailAddress(emailInput);
    const token = randomToken("vfy");
    const challengeId = randomUUID();
    const expiresAt = new Date(
      Date.now() + PUBLIC_SIGNUP_LIFETIME_SECONDS * 1_000
    );
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      requirePublicSignupEnabled(
        await this.policy.currentForAccountChange(connection)
      );
      const existingIdentity = await accountCreationEmailClaimed(connection, email);
      await connection.query(
        `UPDATE authentication_challenges SET invalidated_at = now()
         WHERE purpose = 'public_signup'
           AND normalized_email = $1
           AND consumed_at IS NULL
           AND invalidated_at IS NULL`,
        [email]
      );
      await connection.query(
        `INSERT INTO authentication_challenges
           (id, purpose, token_hash, normalized_email, expires_at, max_attempts)
         VALUES ($1, 'public_signup', $2, $3, $4, 1)`,
        [challengeId, tokenHash(token), email, expiresAt]
      );
      await audit(connection, null, "public_signup.requested", challengeId, {});
      await connection.query("COMMIT");
      if (existingIdentity) return null;
      return { challengeId, email, token, expiresAt };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  async details(token: string): Promise<PublicSignupVerificationDetails> {
    if (token.length > 200) throw new InvalidPublicSignupVerificationError();
    requirePublicSignupEnabled(await this.policy.current());
    const challenge = await this.db.query<PublicSignupChallengeRow>(
      `SELECT id, normalized_email, expires_at
       FROM authentication_challenges
       WHERE purpose = 'public_signup'
         AND token_hash = $1
         AND consumed_at IS NULL
         AND invalidated_at IS NULL
         AND attempt_count < max_attempts
         AND expires_at > now()`,
      [tokenHash(token)]
    );
    const row = challenge.rows[0];
    if (!row) throw new InvalidPublicSignupVerificationError();
    return { email: row.normalized_email, expiresAt: new Date(row.expires_at) };
  }

  async complete(input: CompletePublicSignupInput) {
    const name = requiredText(input.name, 100, "Account name");
    if (input.verificationToken.length > 200) {
      throw new InvalidPublicSignupVerificationError();
    }
    const settings = await this.policy.current();
    requirePublicSignupEnabled(settings);
    agreementsMatch(settings, input);
    const challengeHash = tokenHash(input.verificationToken);
    const preliminary = await this.db.query<PublicSignupChallengeRow>(
      `SELECT id, normalized_email, expires_at
       FROM authentication_challenges
       WHERE purpose = 'public_signup'
         AND token_hash = $1
         AND consumed_at IS NULL
         AND invalidated_at IS NULL
         AND attempt_count < max_attempts
         AND expires_at > now()`,
      [challengeHash]
    );
    if (!preliminary.rows[0]) {
      throw new InvalidPublicSignupVerificationError();
    }
    const passwordHash = await hashPassword(input.password);
    const userId = randomUUID();
    const emailIdentityId = randomUUID();
    const sessionId = randomUUID();
    const sessionToken = randomToken("ses");
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const currentSettings = await this.policy.currentForAccountChange(connection);
      requirePublicSignupEnabled(currentSettings);
      agreementsMatch(currentSettings, input);
      const consumed = await connection.query<PublicSignupChallengeRow>(
        `UPDATE authentication_challenges SET
           consumed_at = now(),
           attempt_count = attempt_count + 1
         WHERE purpose = 'public_signup'
           AND token_hash = $1
           AND consumed_at IS NULL
           AND invalidated_at IS NULL
           AND attempt_count < max_attempts
           AND expires_at > now()
         RETURNING id, normalized_email, expires_at`,
        [challengeHash]
      );
      const challenge = consumed.rows[0];
      if (
        !challenge
        || await accountCreationEmailClaimed(
          connection,
          challenge.normalized_email
        )
      ) {
        throw new InvalidPublicSignupVerificationError();
      }
      await connection.query(
        "INSERT INTO users (id, email, name) VALUES ($1, NULL, $2)",
        [userId, name]
      );
      if (!await reserveAccountCreationEmail(connection, {
        normalizedEmail: challenge.normalized_email,
        userId,
        source: "email_identity"
      })) {
        throw new InvalidPublicSignupVerificationError();
      }
      await connection.query(
        `INSERT INTO email_identities
           (id, user_id, email, normalized_email, normalization_version,
            verified_at, is_primary)
         VALUES ($1, $2, $3, $3, $4, now(), true)`,
        [
          emailIdentityId,
          userId,
          challenge.normalized_email,
          EMAIL_NORMALIZATION_VERSION
        ]
      );
      await connection.query(
        `INSERT INTO password_credentials (user_id, password_hash)
         VALUES ($1, $2)`,
        [userId, passwordHash]
      );
      await connection.query(
        `INSERT INTO account_agreements
           (user_id, document, version, acceptance_method)
         VALUES
           ($1, 'terms', $2, 'email_verification'),
           ($1, 'privacy', $3, 'email_verification')`,
        [userId, input.termsVersion, input.privacyVersion]
      );
      await materializePublicSignupEntitlement(connection, userId);
      await scheduleOpenBetaWelcomeEmail(connection, { userId, emailIdentityId });
      await scheduleStarterCollection(connection, userId, input.timezone ?? "UTC");
      await connection.query(
        `INSERT INTO sessions
           (id, user_id, token_hash, provider, account_session_epoch,
            expires_at, client_name)
         VALUES ($1, $2, $3, 'password', 1,
                 now() + interval '30 days', $4)`,
        [sessionId, userId, tokenHash(sessionToken), input.clientName ?? null]
      );
      await audit(connection, userId, "account.created", userId, {
        provider: "password",
        verification_challenge_id: challenge.id
      });
      await audit(connection, userId, "session.created", sessionId, {
        provider: "password",
        source: "public_signup"
      });
      await connection.query("COMMIT");
      return {
        token: sessionToken,
        starterCollectionPending: true,
        user: { id: userId, email: challenge.normalized_email, name }
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
    outcome: PublicSignupDeliveryOutcome
  ): Promise<void> {
    await audit(
      this.db,
      null,
      outcome.status === "sent"
        ? "public_signup.verification_sent"
        : "public_signup.delivery_failed",
      challengeId,
      outcome.status === "sent"
        ? { provider: outcome.provider, message_id: outcome.messageId }
        : {
            provider: outcome.provider,
            code: outcome.code,
            retryable: outcome.retryable
          }
    );
  }
}

function requirePublicSignupEnabled(settings: AuthenticationSettings): void {
  if (
    !settings.passwordAuthEnabled
    || !settings.emailDeliveryEnabled
    || settings.registrationMode !== "open"
  ) {
    throw new PublicSignupUnavailableError();
  }
}

function agreementsMatch(
  settings: AuthenticationSettings,
  input: Pick<CompletePublicSignupInput, "termsVersion" | "privacyVersion">
): void {
  if (
    !settings.termsVersion
    || !settings.privacyVersion
    || settings.termsVersion !== input.termsVersion
    || settings.privacyVersion !== input.privacyVersion
  ) {
    throw new InvalidPublicSignupVerificationError();
  }
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

async function audit(
  db: DatabaseQueryable,
  userId: string | null,
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
