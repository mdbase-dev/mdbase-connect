import { randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { createDatabase, type DatabasePool } from "./db.js";
import { createExternalSession } from "./external-auth.js";
import {
  InvalidInvitationError,
  InvitationTargetConflictError,
  PasswordAccountService,
  PasswordAuthenticationUnavailableError,
  PasswordLoginRejectedError
} from "./password-auth.js";
import { tokenHash } from "./security.js";
import { flipEvidenceDigest } from "./features/next/migration-rollout.js";
import {
  PASSWORD_HASH_PARAMETERS,
  passwordHashNeedsUpgrade
} from "./password.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("invite-only password accounts", () => {
  it("creates a genuine LAB legacy fixture via invitation signup without changing the next default", async () => {
    const { db, policy } = await fixture();
    const service = new PasswordAccountService(db, policy, "next", "lab");
    const invitation = await service.createInvitation({
      email: "seeder-backend-fixture@lab.invalid", actor: "operator:test",
      reason: "[test] disposable migration fixture", entitlementProfile: null,
      accountBackend: "legacy"
    });
    const accepted = await service.acceptInvitation({ invitationToken: invitation.token,
      name: "[test] Legacy fixture", password: "a durable migration fixture password",
      termsVersion: invitation.termsVersion, privacyVersion: invitation.privacyVersion });
    expect((await db.query("SELECT account_backend FROM users WHERE id = $1", [accepted.user.id])).rows)
      .toEqual([{ account_backend: "legacy" }]);
    expect((await db.query("SELECT account_id FROM next_migration_account_flips WHERE account_id = $1", [accepted.user.id])).rows).toEqual([]);
    const normal = await service.createInvitation({ email: "normal-default@example.com",
      actor: "operator:test", reason: "Normal invitation", entitlementProfile: null });
    const next = await service.acceptInvitation({ invitationToken: normal.token,
      name: "Normal account", password: "a durable normal account password",
      termsVersion: normal.termsVersion, privacyVersion: normal.privacyVersion });
    expect((await db.query("SELECT account_backend FROM users WHERE id = $1", [next.user.id])).rows)
      .toEqual([{ account_backend: "next" }]);
  });
  it.each([undefined, "dev", "staging", "production", "LAB"])("refuses the override outside explicit LAB (%s)", async environment => {
    const { db, policy } = await fixture();
    const service = new PasswordAccountService(db, policy, "next", environment);
    await expect(service.createInvitation({ email: "fixture@lab.invalid", actor: "operator:test",
      reason: "[test] migration fixture", entitlementProfile: null, accountBackend: "legacy" }))
      .rejects.toThrow(/LAB \[test\] fixture/);
    expect((await db.query("SELECT id FROM invitations")).rows).toEqual([]);
  });
  it.each([
    ["person@example.com", "[test] fixture"], ["fixture@lab.invalid.evil.example", "[test] fixture"],
    ["fixture@lab.invalid", "ordinary invitation"], ["fixture@lab.invalid", "[test]not-marked"]
  ])("refuses non-fixture override inputs (%s/%s)", async (email, reason) => {
    const { db, policy } = await fixture();
    const service = new PasswordAccountService(db, policy, "next", "lab");
    await expect(service.createInvitation({ email, reason, actor: "operator:test",
      entitlementProfile: null, accountBackend: "legacy" })).rejects.toThrow(/LAB \[test\] fixture/);
    expect((await db.query("SELECT id FROM invitations")).rows).toEqual([]);
  });
  it("refuses fixture redemption after environment change or without [test] account marking", async () => {
    const { db, policy } = await fixture();
    const service = new PasswordAccountService(db, policy, "next", "lab");
    const invitation = await service.createInvitation({ email: "fixture@lab.invalid", actor: "operator:test",
      reason: "[test] migration fixture", entitlementProfile: null, accountBackend: "legacy" });
    const input = { invitationToken: invitation.token, name: "[test] Fixture",
      password: "a durable fixture account password", termsVersion: invitation.termsVersion, privacyVersion: invitation.privacyVersion };
    await expect(new PasswordAccountService(db, policy, "next", "production").acceptInvitation(input))
      .rejects.toThrow(InvalidInvitationError);
    await expect(service.acceptInvitation({ ...input, name: "Ordinary account" })).rejects.toThrow(InvalidInvitationError);
    expect((await db.query("SELECT id FROM users")).rows).toEqual([]);
    expect((await db.query("SELECT accepted_at FROM invitations WHERE id = $1", [invitation.id])).rows)
      .toEqual([{ accepted_at: null }]);
  });
  it("rejects an omitted entitlement even when called without the operator CLI", async () => {
    const { db, service } = await fixture();
    const input = {
      email: "person@example.com",
      actor: "operator:test",
      reason: "An accidental omission must not create an invitation"
    };
    // @ts-expect-error Exercise a JavaScript/operator caller violating the required input.
    await expect(service.createInvitation(input)).rejects.toThrow(/entitlement profile must be explicit/);
    expect((await db.query("SELECT id FROM invitations")).rows).toHaveLength(0);
    expect((await db.query("SELECT id FROM audit_events WHERE event_type = 'invitation.created'")).rows).toHaveLength(0);
  });

  it("issues only one active hashed invitation for a new identity", async () => {
    const { db, service } = await fixture();
    const first = await service.createInvitation({
      entitlementProfile: null,
      email: "  Person@Example.com ",
      actor: "operator:test",
      reason: "Private beta"
    });
    expect(first).toMatchObject({
      email: "Person@Example.com",
      termsVersion: "terms-2026-07",
      privacyVersion: "privacy-2026-07"
    });
    expect(first.token).toMatch(/^inv_/);
    const stored = await db.query<{
      normalized_email: string;
      token_hash: string;
      revoked_at: Date | null;
    }>(
      `SELECT normalized_email, token_hash, revoked_at
       FROM invitations WHERE id = $1`,
      [first.id]
    );
    expect(stored.rows[0]).toMatchObject({
      normalized_email: "person@example.com",
      token_hash: tokenHash(first.token),
      revoked_at: null
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(first.token);

    const replacement = await service.createInvitation({
      entitlementProfile: null,
      email: "person@example.com",
      actor: "operator:test",
      reason: "Replace a lost invitation"
    });
    expect(replacement.id).not.toBe(first.id);
    const invitations = await db.query<{
      id: string;
      normalized_email: string;
      revoked_at: Date | null;
    }>(
      "SELECT id, normalized_email, revoked_at FROM invitations"
    );
    const matchingInvitations = invitations.rows.filter(
      ({ normalized_email }) => normalized_email === "person@example.com"
    );
    expect(matchingInvitations).toHaveLength(2);
    expect(matchingInvitations.find(({ id }) => id === first.id)?.revoked_at)
      .not.toBeNull();
    expect(matchingInvitations.find(({ id }) => id === replacement.id)?.revoked_at)
      .toBeNull();
  });

  it("atomically creates a verified account, Beta entitlement, and session", async () => {
    const { db, service } = await fixture();
    const invitation = await service.createInvitation({
      email: "person@example.com",
      actor: "operator:test",
      reason: "Private beta",
      entitlementProfile: "beta_v1"
    });
    const accepted = await service.acceptInvitation({
      invitationToken: invitation.token,
      name: "Person Example",
      password: "a durable private beta password",
      termsVersion: invitation.termsVersion,
      privacyVersion: invitation.privacyVersion,
      timezone: "Australia/Melbourne"
    });
    expect(accepted.user).toMatchObject({
      email: "person@example.com",
      name: "Person Example"
    });
    expect(accepted.token).toMatch(/^ses_/);
    expect(accepted.starterCollectionPending).toBe(true);

    const account = await db.query<{
      account_email: string | null;
      identity_email: string;
      normalized_email: string;
      verified_at: Date;
      is_primary: boolean;
      password_hash: string;
      provider: string;
      token_hash: string;
    }>(
      `SELECT u.email AS account_email, e.email AS identity_email,
              e.normalized_email, e.verified_at, e.is_primary,
              p.password_hash, s.provider, s.token_hash
       FROM users u
       JOIN email_identities e ON e.user_id = u.id
       JOIN password_credentials p ON p.user_id = u.id
       JOIN sessions s ON s.user_id = u.id
       WHERE u.id = $1`,
      [accepted.user.id]
    );
    expect(account.rows[0]).toMatchObject({
      account_email: null,
      identity_email: "person@example.com",
      normalized_email: "person@example.com",
      is_primary: true,
      provider: "password",
      token_hash: tokenHash(accepted.token)
    });
    expect(account.rows[0]?.verified_at).toBeInstanceOf(Date);
    expect(account.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);

    const agreements = await db.query<{ document: string; version: string }>(
      `SELECT document, version FROM account_agreements
       WHERE user_id = $1 ORDER BY document`,
      [accepted.user.id]
    );
    expect(agreements.rows).toEqual([
      { document: "privacy", version: "privacy-2026-07" },
      { document: "terms", version: "terms-2026-07" }
    ]);
    const acceptedInvitation = await db.query<{
      accepted_by_user_id: string;
      accepted_at: Date;
    }>(
      "SELECT accepted_by_user_id, accepted_at FROM invitations WHERE id = $1",
      [invitation.id]
    );
    expect(acceptedInvitation.rows[0]?.accepted_by_user_id)
      .toBe(accepted.user.id);
    expect(acceptedInvitation.rows[0]?.accepted_at).toBeInstanceOf(Date);
    const entitlement = await db.query<{
      profile_code: string;
      provider_account_id: string;
      onboarding_enabled: boolean;
    }>(
      `SELECT entitlement.profile_code, storage.provider_account_id,
              preferences.onboarding_enabled
       FROM account_entitlement_grants entitlement
       JOIN account_storage_accounts storage
         ON storage.user_id = entitlement.user_id
       JOIN account_email_preferences preferences
         ON preferences.user_id = entitlement.user_id
       WHERE entitlement.user_id = $1`,
      [accepted.user.id]
    );
    expect(entitlement.rows[0]).toMatchObject({
      profile_code: "beta_v1",
      onboarding_enabled: true
    });
    expect(entitlement.rows[0]?.provider_account_id).toMatch(
      /^[0-9a-f-]{36}$/u
    );
    const welcome = await db.query<{
      message_kind: string;
      template_version: number;
      category: string;
      state: string;
      scheduled_for: Date;
      created_at: Date;
    }>(
      `SELECT message_kind, template_version, category, state,
              scheduled_for, created_at
       FROM email_jobs WHERE user_id = $1`,
      [accepted.user.id]
    );
    expect(welcome.rows).toHaveLength(1);
    expect(welcome.rows[0]).toMatchObject({
      message_kind: "beta_welcome",
      template_version: 1,
      category: "onboarding",
      state: "scheduled"
    });
    const welcomeDelayMs =
      welcome.rows[0]!.scheduled_for.getTime()
        - welcome.rows[0]!.created_at.getTime();
    expect(welcomeDelayMs).toBeGreaterThanOrEqual(86_399_000);
    expect(welcomeDelayMs).toBeLessThanOrEqual(86_401_000);
    const onboarding = await db.query<{
      starter_collection_id: string;
      template_version: string;
      timezone: string;
      provisioned_at: Date | null;
    }>(
      `SELECT starter_collection_id, template_version, timezone, provisioned_at
       FROM account_onboarding WHERE user_id = $1`,
      [accepted.user.id]
    );
    expect(onboarding.rows[0]).toMatchObject({
      template_version: "starter-v1",
      timezone: "Australia/Melbourne",
      provisioned_at: null
    });
    expect(onboarding.rows[0]?.starter_collection_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("supports password login without exposing unknown, wrong, or suspended accounts", async () => {
    const { db, service } = await fixture();
    const invitation = await service.createInvitation({
      email: "person@example.com",
      actor: "operator:test",
      reason: "Private beta",
      entitlementProfile: null
    });
    const account = await service.acceptInvitation({
      invitationToken: invitation.token,
      name: "Person Example",
      password: "a durable private beta password",
      termsVersion: invitation.termsVersion,
      privacyVersion: invitation.privacyVersion
    });

    const login = await service.authenticate({
      email: "PERSON@example.com",
      password: "a durable private beta password"
    });
    expect(login.user).toEqual(account.user);
    expect(login.token).not.toBe(account.token);

    await expect(service.authenticate({
      email: "person@example.com",
      password: "an incorrect private beta password"
    })).rejects.toBeInstanceOf(PasswordLoginRejectedError);
    await expect(service.authenticate({
      email: "unknown@example.com",
      password: "an incorrect private beta password"
    })).rejects.toBeInstanceOf(PasswordLoginRejectedError);

    await db.query(
      "UPDATE users SET suspended_at = now() WHERE id = $1",
      [account.user.id]
    );
    await expect(service.authenticate({
      email: "person@example.com",
      password: "a durable private beta password"
    })).rejects.toBeInstanceOf(PasswordLoginRejectedError);
  });

  it("upgrades an older Argon2 work factor after successful authentication", async () => {
    const { db, service } = await fixture();
    const invitation = await service.createInvitation({
      email: "upgrade@example.com",
      actor: "operator:test",
      reason: "Credential upgrade test",
      entitlementProfile: null
    });
    const password = "a durable credential upgrade password";
    const account = await service.acceptInvitation({
      invitationToken: invitation.token,
      name: "Upgrade Person",
      password,
      termsVersion: invitation.termsVersion,
      privacyVersion: invitation.privacyVersion
    });
    const weakerHash = await hash(password, {
      ...PASSWORD_HASH_PARAMETERS,
      memoryCost: 12_288
    });
    await db.query(
      `UPDATE password_credentials
       SET password_hash = $2, credential_version = 1
       WHERE user_id = $1`,
      [account.user.id, weakerHash]
    );

    await service.authenticate({
      email: invitation.email,
      password
    });

    const credential = await db.query<{
      password_hash: string;
      credential_version: number;
    }>(
      `SELECT password_hash, credential_version
       FROM password_credentials WHERE user_id = $1`,
      [account.user.id]
    );
    expect(passwordHashNeedsUpgrade(credential.rows[0]!.password_hash)).toBe(false);
    expect(credential.rows[0]?.credential_version).toBe(2);
  });

  it("rejects replay, stale agreements, and disabled registration without partial accounts", async () => {
    const { db, policy, service } = await fixture();
    const invitation = await service.createInvitation({
      email: "person@example.com",
      actor: "operator:test",
      reason: "Private beta",
      entitlementProfile: null
    });
    const input = {
      invitationToken: invitation.token,
      name: "Person Example",
      password: "a durable private beta password",
      termsVersion: invitation.termsVersion,
      privacyVersion: invitation.privacyVersion
    };
    await expect(service.acceptInvitation({
      ...input,
      termsVersion: "terms-not-accepted"
    })).rejects.toBeInstanceOf(InvalidInvitationError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(0);

    await service.acceptInvitation(input);
    await expect(service.acceptInvitation(input))
      .rejects.toBeInstanceOf(InvalidInvitationError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);

    await policy.update({
      registrationMode: "closed",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: false,
      termsVersion: "terms-2026-07",
      privacyVersion: "privacy-2026-07",
      expectedRevision: 1,
      updatedBy: "operator:test",
      reason: "Close registration"
    });
    const closedInvitation = await service.createInvitation({
      email: "second@example.com",
      actor: "operator:test",
      reason: "Prepare without admitting",
      entitlementProfile: null
    });
    await expect(service.acceptInvitation({
      invitationToken: closedInvitation.token,
      name: "Second Person",
      password: "another durable beta password",
      termsVersion: closedInvitation.termsVersion,
      privacyVersion: closedInvitation.privacyVersion
    })).rejects.toBeInstanceOf(PasswordAuthenticationUnavailableError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);
  });

  it("allows only one concurrent redemption of an invitation", async () => {
    const { db, service } = await fixture();
    const invitation = await service.createInvitation({
      email: "concurrent@example.com",
      actor: "operator:test",
      reason: "Concurrent redemption test",
      entitlementProfile: null
    });
    const input = {
      invitationToken: invitation.token,
      name: "Concurrent Person",
      password: "a durable concurrent beta password",
      termsVersion: invitation.termsVersion,
      privacyVersion: invitation.privacyVersion
    };
    const outcomes = await Promise.allSettled([
      service.acceptInvitation(input),
      service.acceptInvitation(input)
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const accepted = await db.query(
      `SELECT id FROM invitations
       WHERE id = $1 AND accepted_at IS NOT NULL`,
      [invitation.id]
    );
    expect(accepted.rows).toHaveLength(1);
  });

  it("refuses email and verified external identity collisions without merging accounts", async () => {
    const { db, service } = await fixture();
    const existingInvitation = await service.createInvitation({
      email: "existing@example.com",
      actor: "operator:test",
      reason: "Create the first account",
      entitlementProfile: null
    });
    await service.acceptInvitation({
      invitationToken: existingInvitation.token,
      name: "Existing",
      password: "the existing account password",
      termsVersion: existingInvitation.termsVersion,
      privacyVersion: existingInvitation.privacyVersion
    });
    await expect(service.createInvitation({
      email: "EXISTING@example.com",
      actor: "operator:test",
      reason: "Must not merge",
      entitlementProfile: null
    })).rejects.toBeInstanceOf(InvitationTargetConflictError);

    await createExternalSession(db, {
      provider: "google",
      subject: "google-subject",
      name: "Google User",
      login: null,
      email: "google@example.com",
      emailVerified: true,
      avatarUrl: null
    });
    await expect(service.createInvitation({
      email: "google@example.com",
      actor: "operator:test",
      reason: "Must require explicit linking",
      entitlementProfile: null
    })).rejects.toBeInstanceOf(InvitationTargetConflictError);
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, 'Legacy@Example.com', 'Legacy')",
      [randomUUID()]
    );
    await expect(service.createInvitation({
      email: "legacy@example.com",
      actor: "operator:test",
      reason: "Must not duplicate a legacy account email",
      entitlementProfile: null
    })).rejects.toBeInstanceOf(InvitationTargetConflictError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(3);
  });

  it.each(["legacy", "next"] as const)("creates an invited account on the configured %s backend", async (backend) => {
    const { db, policy } = await fixture();
    const service = new PasswordAccountService(db, policy, backend);
    const invitation = await service.createInvitation({
      email: "person@example.com", actor: "operator:test", reason: "Private beta", entitlementProfile: null
    });
    const { user } = await service.acceptInvitation({
      invitationToken: invitation.token, name: "Person", password: "a durable private beta password",
      termsVersion: invitation.termsVersion, privacyVersion: invitation.privacyVersion, timezone: "UTC"
    });
    const marker = await db.query<{ account_backend: string }>("SELECT account_backend FROM users WHERE id = $1", [user.id]);
    expect(marker.rows[0]?.account_backend).toBe(backend);
    const flip = await db.query<{ collections: string[]; evidence_digest: string }>(
      "SELECT collections::text[] AS collections, evidence_digest FROM next_migration_account_flips WHERE account_id = $1", [user.id]);
    const audited = await db.query("SELECT 1 FROM audit_events WHERE user_id = $1 AND event_type = 'next_migration.flip'", [user.id]);
    if (backend === "legacy") {
      expect(flip.rows).toEqual([]);
      expect(audited.rows).toEqual([]);
    } else {
      // Exactly what the staged flip writes for an account with no hosted collections.
      expect(flip.rows).toEqual([{ collections: [], evidence_digest: flipEvidenceDigest([]) }]);
      expect(audited.rows).toHaveLength(1);
    }
  });
});

async function fixture(): Promise<{
  db: DatabasePool;
  policy: AuthenticationPolicyStore;
  service: PasswordAccountService;
}> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const policy = new AuthenticationPolicyStore(db, "closed");
  await policy.update({
    registrationMode: "invite",
    passwordAuthEnabled: true,
    emailDeliveryEnabled: false,
    termsVersion: "terms-2026-07",
    privacyVersion: "privacy-2026-07",
    expectedRevision: 0,
    updatedBy: "operator:test",
    reason: "Configure the test fixture"
  });
  return {
    db,
    policy,
    service: new PasswordAccountService(db, policy)
  };
}
