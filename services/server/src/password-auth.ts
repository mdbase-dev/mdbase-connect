import { randomUUID } from "node:crypto";
import type {
  DatabasePool,
  DatabaseQueryable
} from "./db.js";
import {
  EMAIL_NORMALIZATION_VERSION,
  normalizeEmailAddress
} from "./email-identity.js";
import {
  AuthenticationPolicyStore,
  type AuthenticationSettings
} from "./authentication-policy.js";
import {
  hashPassword,
  passwordHashNeedsUpgrade,
  verifyPassword
} from "./password.js";
import { randomToken, tokenHash } from "./security.js";

const DEFAULT_INVITATION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const MIN_INVITATION_LIFETIME_SECONDS = 5 * 60;
const MAX_INVITATION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const DUMMY_PASSWORD_HASH = hashPassword(
  "mdbase timing-only password credential"
);

export interface CreateInvitationInput {
  email: string;
  actor: string;
  reason: string;
  expiresInSeconds?: number;
}

export interface CreatedInvitation {
  id: string;
  email: string;
  token: string;
  expiresAt: Date;
  termsVersion: string;
  privacyVersion: string;
}

export interface AcceptInvitationInput {
  invitationToken: string;
  name: string;
  password: string;
  termsVersion: string;
  privacyVersion: string;
}

export interface PasswordLoginInput {
  email: string;
  password: string;
}

export type InvitationDeliveryOutcome =
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

export interface PasswordSession {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
}

export interface InvitationDetails {
  email: string;
  termsVersion: string;
  privacyVersion: string;
  expiresAt: Date;
}

interface InvitationRow {
  id: string;
  email: string;
  normalized_email: string;
  terms_version: string | null;
  privacy_version: string | null;
  expires_at: Date | string;
}

interface PasswordCredentialRow {
  user_id: string;
  name: string;
  email: string;
  password_hash: string;
  suspended_at: Date | string | null;
  session_epoch: string | number;
}

export class PasswordAuthenticationUnavailableError extends Error {
  constructor() {
    super("Password authentication is unavailable.");
    this.name = "PasswordAuthenticationUnavailableError";
  }
}

export class AuthenticationPolicyIncompleteError extends Error {
  constructor() {
    super("Current terms and privacy versions must be configured first.");
    this.name = "AuthenticationPolicyIncompleteError";
  }
}

export class InvitationTargetConflictError extends Error {
  constructor() {
    super("The invitation address already belongs to an account identity.");
    this.name = "InvitationTargetConflictError";
  }
}

export class InvalidInvitationError extends Error {
  constructor() {
    super("Invitation is invalid or expired.");
    this.name = "InvalidInvitationError";
  }
}

export class PasswordLoginRejectedError extends Error {
  constructor() {
    super("Email or password is incorrect.");
    this.name = "PasswordLoginRejectedError";
  }
}

export class PasswordAccountService {
  constructor(
    private readonly db: DatabasePool,
    private readonly policy: AuthenticationPolicyStore
  ) {}

  async createInvitation(input: CreateInvitationInput): Promise<CreatedInvitation> {
    const actor = requiredText(input.actor, 200, "Invitation actor");
    const reason = requiredText(input.reason, 500, "Invitation reason");
    const normalizedEmail = normalizeEmailAddress(input.email);
    const email = input.email.trim().normalize("NFC");
    const lifetime = input.expiresInSeconds ?? DEFAULT_INVITATION_LIFETIME_SECONDS;
    if (
      !Number.isSafeInteger(lifetime)
      || lifetime < MIN_INVITATION_LIFETIME_SECONDS
      || lifetime > MAX_INVITATION_LIFETIME_SECONDS
    ) {
      throw new TypeError("Invitation lifetime is outside the supported range.");
    }
    const settings = await this.policy.current();
    const agreements = requiredAgreements(settings);
    const token = randomToken("inv");
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + lifetime * 1_000);
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      if (await identityExists(connection, normalizedEmail)) {
        throw new InvitationTargetConflictError();
      }
      await connection.query(
        `UPDATE invitations SET
           revoked_at = now(),
           revoked_by = $2,
           revocation_reason = 'Superseded by a new invitation'
         WHERE normalized_email = $1
           AND accepted_at IS NULL
           AND revoked_at IS NULL`,
        [normalizedEmail, actor]
      );
      await connection.query(
        `INSERT INTO invitations
           (id, email, normalized_email, token_hash, created_by,
            terms_version, privacy_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          email,
          normalizedEmail,
          tokenHash(token),
          actor,
          agreements.termsVersion,
          agreements.privacyVersion,
          expiresAt
        ]
      );
      await audit(connection, null, "invitation.created", id, {
        actor,
        reason
      });
      await connection.query("COMMIT");
      return {
        id,
        email,
        token,
        expiresAt,
        ...agreements
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  async acceptInvitation(input: AcceptInvitationInput): Promise<PasswordSession> {
    const name = requiredText(input.name, 100, "Account name");
    if (input.invitationToken.length > 200) throw new InvalidInvitationError();
    requireSignupEnabled(await this.policy.current());
    const invitationHash = tokenHash(input.invitationToken);
    const preliminary = await this.db.query<InvitationRow>(
      `SELECT id, email, normalized_email, terms_version, privacy_version
       FROM invitations
       WHERE token_hash = $1
         AND accepted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()`,
      [invitationHash]
    );
    if (!preliminary.rows[0]) throw new InvalidInvitationError();
    agreementsMatch(preliminary.rows[0], input);
    const passwordHash = await hashPassword(input.password);
    const userId = randomUUID();
    const sessionId = randomUUID();
    const sessionToken = randomToken("ses");
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const settings = await this.policy.currentForAccountChange(connection);
      requireSignupEnabled(settings);
      const invitation = await connection.query<InvitationRow>(
        `SELECT id, email, normalized_email, terms_version, privacy_version
         FROM invitations
         WHERE token_hash = $1
           AND accepted_at IS NULL
           AND revoked_at IS NULL
           AND expires_at > now()
         FOR UPDATE`,
        [invitationHash]
      );
      const row = invitation.rows[0];
      if (!row) throw new InvalidInvitationError();
      agreementsMatch(row, input);
      const currentAgreements = requiredAgreements(settings);
      if (
        currentAgreements.termsVersion !== row.terms_version
        || currentAgreements.privacyVersion !== row.privacy_version
      ) {
        throw new InvalidInvitationError();
      }
      if (await identityExists(connection, row.normalized_email)) {
        throw new InvitationTargetConflictError();
      }
      await connection.query(
        "INSERT INTO users (id, email, name) VALUES ($1, NULL, $2)",
        [userId, name]
      );
      await connection.query(
        `INSERT INTO email_identities
           (id, user_id, email, normalized_email, normalization_version,
            verified_at, is_primary)
         VALUES ($1, $2, $3, $4, $5, now(), true)`,
        [
          randomUUID(),
          userId,
          row.email,
          row.normalized_email,
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
           ($1, 'terms', $2, 'invitation'),
           ($1, 'privacy', $3, 'invitation')`,
        [userId, currentAgreements.termsVersion, currentAgreements.privacyVersion]
      );
      await connection.query(
        `UPDATE invitations SET accepted_by_user_id = $2, accepted_at = now()
         WHERE id = $1`,
        [row.id, userId]
      );
      await connection.query(
        `INSERT INTO sessions
           (id, user_id, token_hash, provider, account_session_epoch, expires_at)
         VALUES ($1, $2, $3, 'password', 1, now() + interval '30 days')`,
        [sessionId, userId, tokenHash(sessionToken)]
      );
      await audit(connection, userId, "account.created", userId, {
        provider: "password",
        invitation_id: row.id
      });
      await audit(connection, userId, "session.created", sessionId, {
        provider: "password"
      });
      await connection.query("COMMIT");
      return {
        token: sessionToken,
        user: { id: userId, email: row.email, name }
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  async invitationDetails(invitationToken: string): Promise<InvitationDetails> {
    if (invitationToken.length > 200) throw new InvalidInvitationError();
    const settings = await this.policy.current();
    requireSignupEnabled(settings);
    const invitation = await this.db.query<InvitationRow>(
      `SELECT id, email, normalized_email, terms_version, privacy_version,
              expires_at
       FROM invitations
       WHERE token_hash = $1
         AND accepted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()`,
      [tokenHash(invitationToken)]
    );
    const row = invitation.rows[0];
    if (!row) throw new InvalidInvitationError();
    const agreements = requiredAgreements(settings);
    if (
      agreements.termsVersion !== row.terms_version
      || agreements.privacyVersion !== row.privacy_version
    ) {
      throw new InvalidInvitationError();
    }
    return {
      email: row.email,
      ...agreements,
      expiresAt: new Date(row.expires_at)
    };
  }

  async recordInvitationDelivery(
    invitationId: string,
    outcome: InvitationDeliveryOutcome
  ): Promise<void> {
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      if (outcome.status === "sent") {
        const updated = await connection.query(
          `UPDATE invitations SET
             send_count = send_count + 1,
             last_sent_at = now()
           WHERE id = $1
           RETURNING id`,
          [invitationId]
        );
        if (!updated.rows[0]) {
          throw new TypeError("Invitation delivery target does not exist.");
        }
        await audit(connection, null, "invitation.sent", invitationId, {
          provider: outcome.provider,
          message_id: outcome.messageId
        });
      } else {
        await audit(connection, null, "invitation.delivery_failed", invitationId, {
          provider: outcome.provider,
          code: outcome.code,
          retryable: outcome.retryable
        });
      }
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  async authenticate(input: PasswordLoginInput): Promise<PasswordSession> {
    const settings = await this.policy.current();
    if (!settings.passwordAuthEnabled) {
      throw new PasswordAuthenticationUnavailableError();
    }
    const normalizedEmail = normalizeEmailAddress(input.email);
    const credential = await this.db.query<PasswordCredentialRow>(
      `SELECT u.id AS user_id, u.name, e.email, p.password_hash,
              u.suspended_at, u.session_epoch
       FROM email_identities e
       JOIN users u ON u.id = e.user_id
       JOIN password_credentials p ON p.user_id = u.id
       WHERE e.normalized_email = $1
         AND e.retired_at IS NULL
         AND e.verified_at IS NOT NULL`,
      [normalizedEmail]
    );
    const row = credential.rows[0];
    const passwordMatches = await verifyPassword(
      row?.password_hash ?? await DUMMY_PASSWORD_HASH,
      input.password
    );
    if (!row || !passwordMatches || row.suspended_at) {
      throw new PasswordLoginRejectedError();
    }
    const upgradedHash = passwordHashNeedsUpgrade(row.password_hash)
      ? await hashPassword(input.password)
      : null;
    const sessionId = randomUUID();
    const sessionToken = randomToken("ses");
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const current = await connection.query<PasswordCredentialRow>(
        `SELECT u.id AS user_id, u.name, e.email, p.password_hash,
                u.suspended_at, u.session_epoch
         FROM email_identities e
         JOIN users u ON u.id = e.user_id
         JOIN password_credentials p ON p.user_id = u.id
         WHERE e.normalized_email = $1
           AND e.retired_at IS NULL
           AND e.verified_at IS NOT NULL
         FOR UPDATE`,
        [normalizedEmail]
      );
      const active = current.rows[0];
      if (
        !active
        || active.suspended_at
        || active.password_hash !== row.password_hash
      ) {
        throw new PasswordLoginRejectedError();
      }
      if (upgradedHash) {
        await connection.query(
          `UPDATE password_credentials SET
             password_hash = $2,
             credential_version = credential_version + 1,
             updated_at = now()
           WHERE user_id = $1`,
          [active.user_id, upgradedHash]
        );
      }
      await connection.query(
        `INSERT INTO sessions
           (id, user_id, token_hash, provider, account_session_epoch, expires_at)
         VALUES ($1, $2, $3, 'password', $4, now() + interval '30 days')`,
        [
          sessionId,
          active.user_id,
          tokenHash(sessionToken),
          active.session_epoch
        ]
      );
      await audit(connection, active.user_id, "session.created", sessionId, {
        provider: "password"
      });
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

function requiredAgreements(settings: AuthenticationSettings): {
  termsVersion: string;
  privacyVersion: string;
} {
  if (!settings.termsVersion || !settings.privacyVersion) {
    throw new AuthenticationPolicyIncompleteError();
  }
  return {
    termsVersion: settings.termsVersion,
    privacyVersion: settings.privacyVersion
  };
}

function requireSignupEnabled(settings: AuthenticationSettings): void {
  if (
    !settings.passwordAuthEnabled
    || settings.registrationMode !== "invite"
  ) {
    throw new PasswordAuthenticationUnavailableError();
  }
}

function agreementsMatch(
  invitation: InvitationRow,
  input: Pick<AcceptInvitationInput, "termsVersion" | "privacyVersion">
): void {
  if (
    invitation.terms_version !== input.termsVersion
    || invitation.privacy_version !== input.privacyVersion
  ) {
    throw new InvalidInvitationError();
  }
}

async function identityExists(
  db: DatabaseQueryable,
  normalizedEmail: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT user_id FROM email_identities
     WHERE normalized_email = $1 AND retired_at IS NULL
     UNION ALL
     SELECT user_id FROM external_identities
     WHERE normalized_email = $1 AND email_verified = true
     UNION ALL
     SELECT id AS user_id FROM users
     WHERE email IS NOT NULL AND lower(email) = lower($1)
     LIMIT 1`,
    [normalizedEmail]
  );
  return Boolean(result.rows[0]);
}

function requiredText(value: string, maxLength: number, name: string): string {
  const normalized = value.trim().normalize("NFC");
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${name} must contain between 1 and ${maxLength} characters.`);
  }
  return normalized;
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
