import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { createDatabase, type DatabasePool } from "./db.js";
import { createExternalSession } from "./external-auth.js";
import {
  InvalidPublicSignupVerificationError,
  PublicSignupService,
  PublicSignupUnavailableError
} from "./public-signup.js";
import { tokenHash } from "./security.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("public password signup", () => {
  it("creates a verified account, session, entitlement, and starter collection atomically", async () => {
    const { db, service } = await fixture();
    const verification = await service.create(" Person@Example.com ");
    expect(verification).toMatchObject({ email: "person@example.com" });
    expect(verification?.token).toMatch(/^vfy_/u);
    const stored = await db.query<{
      token_hash: string;
      normalized_email: string;
    }>(
      `SELECT token_hash, normalized_email
       FROM authentication_challenges WHERE id = $1`,
      [verification!.challengeId]
    );
    expect(stored.rows[0]).toEqual({
      token_hash: tokenHash(verification!.token),
      normalized_email: "person@example.com"
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(verification!.token);

    const details = await service.details(verification!.token);
    expect(details.email).toBe("person@example.com");
    const account = await service.complete({
      verificationToken: verification!.token,
      name: "Person Example",
      password: "a durable public account password",
      termsVersion: "terms-2026-08",
      privacyVersion: "privacy-2026-08",
      timezone: "Australia/Melbourne"
    });
    expect(account.user).toMatchObject({
      email: "person@example.com",
      name: "Person Example"
    });
    expect(account.token).toMatch(/^ses_/u);

    const materialized = await db.query<{
      verified_at: Date;
      provider: string;
      profile_code: string;
      source_reference: string;
      timezone: string;
      message_kind: string;
      template_version: number;
    }>(
      `SELECT identity.verified_at, session.provider, entitlement.profile_code,
              entitlement.source_reference, onboarding.timezone,
              email_job.message_kind, email_job.template_version
       FROM email_identities identity
       JOIN sessions session ON session.user_id = identity.user_id
       JOIN account_entitlement_grants entitlement
         ON entitlement.user_id = identity.user_id
       JOIN account_onboarding onboarding ON onboarding.user_id = identity.user_id
       JOIN email_jobs email_job ON email_job.user_id = identity.user_id
       WHERE identity.user_id = $1`,
      [account.user.id]
    );
    expect(materialized.rows[0]).toMatchObject({
      provider: "password",
      profile_code: "open_beta_v1",
      source_reference: "public_signup_v1",
      timezone: "Australia/Melbourne",
      message_kind: "open_beta_welcome",
      template_version: 1
    });
    expect(materialized.rows[0]?.verified_at).toBeInstanceOf(Date);
    const agreements = await db.query<{
      document: string;
      acceptance_method: string;
    }>(
      `SELECT document, acceptance_method FROM account_agreements
       WHERE user_id = $1 ORDER BY document`,
      [account.user.id]
    );
    expect(agreements.rows).toEqual([
      { document: "privacy", acceptance_method: "email_verification" },
      { document: "terms", acceptance_method: "email_verification" }
    ]);
  });

  it("invalidates replacement links and rejects replay or stale agreements without partial accounts", async () => {
    const { db, policy, service } = await fixture();
    const first = await service.create("person@example.com");
    const replacement = await service.create("PERSON@example.com");
    await expect(service.details(first!.token))
      .rejects.toBeInstanceOf(InvalidPublicSignupVerificationError);
    await expect(service.complete({
      verificationToken: replacement!.token,
      name: "Person Example",
      password: "a durable public account password",
      termsVersion: "old-terms",
      privacyVersion: "privacy-2026-08"
    })).rejects.toBeInstanceOf(InvalidPublicSignupVerificationError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(0);

    const input = {
      verificationToken: replacement!.token,
      name: "Person Example",
      password: "a durable public account password",
      termsVersion: "terms-2026-08",
      privacyVersion: "privacy-2026-08"
    };
    await service.complete(input);
    await expect(service.complete(input))
      .rejects.toBeInstanceOf(InvalidPublicSignupVerificationError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);

    await policy.update({
      registrationMode: "closed",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: true,
      termsVersion: "terms-2026-08",
      privacyVersion: "privacy-2026-08",
      expectedRevision: 1,
      updatedBy: "operator:test",
      reason: "Close public signup"
    });
    await expect(service.create("second@example.com"))
      .rejects.toBeInstanceOf(PublicSignupUnavailableError);
  });

  it("returns no challenge for any existing verified identity", async () => {
    const { db, service } = await fixture();
    const existing = await service.create("existing@example.com");
    await service.complete({
      verificationToken: existing!.token,
      name: "Existing",
      password: "the existing account password",
      termsVersion: "terms-2026-08",
      privacyVersion: "privacy-2026-08"
    });
    expect(await service.create("EXISTING@example.com")).toBeNull();

    await createExternalSession(db, {
      provider: "google",
      subject: "google-subject",
      name: "Google User",
      login: null,
      email: "google@example.com",
      emailVerified: true,
      avatarUrl: null
    });
    expect(await service.create("google@example.com")).toBeNull();
  });

  it("rejects a new external account after password signup claims the email", async () => {
    const { db, service } = await fixture();
    const verification = await service.create("shared@example.com");
    await service.complete({
      verificationToken: verification!.token,
      name: "Password Account",
      password: "a durable public account password",
      termsVersion: "terms-2026-08",
      privacyVersion: "privacy-2026-08"
    });

    await expect(createExternalSession(db, {
      provider: "google",
      subject: "same-email-google-subject",
      name: "Google Account",
      login: null,
      email: "SHARED@example.com",
      emailVerified: true,
      avatarUrl: null
    }, { allowAccountCreation: true })).rejects.toMatchObject({
      name: "AccountUnavailableError"
    });
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);
    expect((await db.query(
      "SELECT provider, subject FROM external_identities"
    )).rows).toHaveLength(0);
    expect((await db.query(
      `SELECT normalized_email, user_id
       FROM account_creation_email_claims`
    )).rows).toEqual([{
      normalized_email: "shared@example.com",
      user_id: (await db.query<{ id: string }>("SELECT id FROM users")).rows[0]!.id
    }]);
  });

  it("allows only one account to win concurrent verified-email creation", async () => {
    const { db, service } = await fixture();
    const verification = await service.create("race@example.com");
    const passwordCompletion = service.complete({
      verificationToken: verification!.token,
      name: "Password Account",
      password: "a durable public account password",
      termsVersion: "terms-2026-08",
      privacyVersion: "privacy-2026-08"
    });
    const externalCompletion = createExternalSession(db, {
      provider: "google",
      subject: "race-google-subject",
      name: "Google Account",
      login: null,
      email: "race@example.com",
      emailVerified: true,
      avatarUrl: null
    }, { allowAccountCreation: true });

    const results = await Promise.allSettled([
      passwordCompletion,
      externalCompletion
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);
    expect((await db.query(
      `SELECT normalized_email FROM account_creation_email_claims
       WHERE normalized_email = 'race@example.com'`
    )).rows).toHaveLength(1);
  });

  it("rejects expired links and an identity claimed after verification was requested", async () => {
    const { db, service } = await fixture();
    const expired = await service.create("expired@example.com");
    await db.query(
      "UPDATE authentication_challenges SET expires_at = now() - interval '1 second' WHERE id = $1",
      [expired!.challengeId]
    );
    await expect(service.details(expired!.token))
      .rejects.toBeInstanceOf(InvalidPublicSignupVerificationError);

    const claimed = await service.create("claimed@example.com");
    await createExternalSession(db, {
      provider: "google",
      subject: "claimed-google-subject",
      name: "Claimed User",
      login: null,
      email: "claimed@example.com",
      emailVerified: true,
      avatarUrl: null
    });
    await expect(service.complete({
      verificationToken: claimed!.token,
      name: "Second Account",
      password: "a durable public account password",
      termsVersion: "terms-2026-08",
      privacyVersion: "privacy-2026-08"
    })).rejects.toBeInstanceOf(InvalidPublicSignupVerificationError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);
  });
});

async function fixture(): Promise<{
  db: DatabasePool;
  policy: AuthenticationPolicyStore;
  service: PublicSignupService;
}> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const policy = new AuthenticationPolicyStore(db, "closed");
  await policy.update({
    registrationMode: "open",
    passwordAuthEnabled: true,
    emailDeliveryEnabled: true,
    termsVersion: "terms-2026-08",
    privacyVersion: "privacy-2026-08",
    expectedRevision: 0,
    updatedBy: "operator:test",
    reason: "Configure public signup tests"
  });
  return { db, policy, service: new PublicSignupService(db, policy) };
}
