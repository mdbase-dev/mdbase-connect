import { randomUUID } from "node:crypto";
import type { AuthenticationPolicyStore, AuthenticationSettings } from "./authentication-policy.js";
import type { DatabasePool } from "./database-types.js";
import { EMAIL_NORMALIZATION_VERSION, normalizeEmailAddress } from "./email-identity.js";
import { createExternalSessionInTransaction, type VerifiedExternalIdentity } from "./external-auth.js";
import { completePublicAccountOnboarding } from "./public-account-onboarding.js";
import { PublicSignupUnavailableError } from "./public-signup.js";
import { randomToken, safeEqual, tokenHash } from "./security.js";

export class InvalidExternalSignupError extends Error {
  constructor() {
    super("Account setup expired or changed. Please start again with Google or GitHub.");
    this.name = "InvalidExternalSignupError";
  }
}

export class ExternalSignupEmailRequiredError extends Error {
  constructor() {
    super("A verified email is required. Verify your primary email with your identity provider, or sign up using email instead.");
    this.name = "ExternalSignupEmailRequiredError";
  }
}

interface SignupProof {
  identity: VerifiedExternalIdentity;
  return_to: string;
}

export class ExternalSignupService {
  constructor(
    private readonly db: DatabasePool,
    private readonly policy: AuthenticationPolicyStore,
    private readonly providers: ReadonlySet<VerifiedExternalIdentity["provider"]>
  ) {}

  async create(identity: VerifiedExternalIdentity, returnTo: string): Promise<string> {
    requireOpenSignup(await this.policy.current());
    if (!this.providers.has(identity.provider)) throw new PublicSignupUnavailableError();
    if (!identity.emailVerified || !identity.email) throw new ExternalSignupEmailRequiredError();
    const email = normalizeEmailAddress(identity.email);
    const token = randomToken("signup");
    await this.db.query("DELETE FROM external_signup_challenges WHERE expires_at <= now()");
    await this.db.query(
      `INSERT INTO external_signup_challenges (token_hash, identity, return_to, expires_at)
       VALUES ($1, $2::jsonb, $3, now() + interval '10 minutes')`,
      [tokenHash(token), JSON.stringify({ ...identity, email }), returnTo]
    );
    return token;
  }

  async details(token: string): Promise<SignupProof & { proofId: string }> {
    requireOpenSignup(await this.policy.current());
    const proof = await this.db.query<SignupProof>(
      `SELECT identity, return_to FROM external_signup_challenges
       WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash(token)]
    );
    if (!proof.rows[0]) throw new InvalidExternalSignupError();
    if (!this.providers.has(proof.rows[0].identity.provider)) throw new PublicSignupUnavailableError();
    return { ...proof.rows[0], proofId: tokenHash(token) };
  }

  async complete(token: string, input: {
    proofId: string;
    name: string;
    termsVersion: string;
    privacyVersion: string;
    timezone: string;
    clientName: string;
  }) {
    // Bind confirmation to the identity displayed by preview. Another tab may
    // have replaced the browser cookie while this form was open. The digest is
    // a correlation ID, not a bearer credential: the raw cookie is still required.
    if (!safeEqual(input.proofId, tokenHash(token))) throw new InvalidExternalSignupError();
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const settings = await this.policy.currentForAccountChange(connection);
      requireOpenSignup(settings);
      if (settings.termsVersion !== input.termsVersion || settings.privacyVersion !== input.privacyVersion) {
        throw new InvalidExternalSignupError();
      }
      // DELETE RETURNING is single-use across instances, and rolls back with all
      // account writes if email claims, onboarding, or session creation fail.
      const consumed = await connection.query<SignupProof>(
        `DELETE FROM external_signup_challenges
         WHERE token_hash = $1 AND expires_at > now()
         RETURNING identity, return_to`,
        [tokenHash(token)]
      );
      const proof = consumed.rows[0];
      if (!proof) throw new InvalidExternalSignupError();
      const identity = proof.identity;
      if (!this.providers.has(identity.provider)) throw new PublicSignupUnavailableError();
      if (!identity.emailVerified || !identity.email) throw new ExternalSignupEmailRequiredError();
      const session = await createExternalSessionInTransaction(connection, {
        ...identity,
        name: input.name
      }, { clientName: input.clientName, allowAccountCreation: true });
      if (session.createdAccount) {
        const emailIdentityId = randomUUID();
        const email = normalizeEmailAddress(identity.email);
        await connection.query(
          `INSERT INTO email_identities
             (id, user_id, email, normalized_email, normalization_version, verified_at, is_primary)
           VALUES ($1, $2, $3, $3, $4, now(), true)`,
          [emailIdentityId, session.userId, email, EMAIL_NORMALIZATION_VERSION]
        );
        await completePublicAccountOnboarding(connection, {
          ...input,
          userId: session.userId,
          emailIdentityId,
          acceptanceMethod: "external_identity"
        });
        await connection.query(
          `INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata)
           VALUES ($1, $2::uuid, 'account.created', $2::text, $3::jsonb)`,
          [randomUUID(), session.userId, JSON.stringify({ provider: identity.provider, source: "public_signup" })]
        );
      }
      await connection.query("COMMIT");
      return { ...session, returnTo: proof.return_to };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}

function requireOpenSignup(settings: AuthenticationSettings): void {
  if (settings.registrationMode !== "open" || !settings.termsVersion || !settings.privacyVersion) {
    throw new PublicSignupUnavailableError();
  }
}
