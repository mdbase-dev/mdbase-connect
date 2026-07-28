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
import {
  PASSWORD_HASH_PARAMETERS,
  passwordHashNeedsUpgrade
} from "./password.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("invite-only password accounts", () => {
  it("issues only one active hashed invitation for a new identity", async () => {
    const { db, service } = await fixture();
    const first = await service.createInvitation({
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

  it("atomically creates a verified account, credential, agreements, and session", async () => {
    const { db, service } = await fixture();
    const invitation = await service.createInvitation({
      email: "person@example.com",
      actor: "operator:test",
      reason: "Private beta"
    });
    const accepted = await service.acceptInvitation({
      invitationToken: invitation.token,
      name: "Person Example",
      password: "a durable private beta password",
      termsVersion: invitation.termsVersion,
      privacyVersion: invitation.privacyVersion
    });
    expect(accepted.user).toMatchObject({
      email: "person@example.com",
      name: "Person Example"
    });
    expect(accepted.token).toMatch(/^ses_/);

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
  });

  it("supports password login without exposing unknown, wrong, or suspended accounts", async () => {
    const { db, service } = await fixture();
    const invitation = await service.createInvitation({
      email: "person@example.com",
      actor: "operator:test",
      reason: "Private beta"
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
      reason: "Credential upgrade test"
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
      reason: "Private beta"
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
      reason: "Prepare without admitting"
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
      reason: "Concurrent redemption test"
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
      reason: "Create the first account"
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
      reason: "Must not merge"
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
      reason: "Must require explicit linking"
    })).rejects.toBeInstanceOf(InvitationTargetConflictError);
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, 'Legacy@Example.com', 'Legacy')",
      [randomUUID()]
    );
    await expect(service.createInvitation({
      email: "legacy@example.com",
      actor: "operator:test",
      reason: "Must not duplicate a legacy account email"
    })).rejects.toBeInstanceOf(InvitationTargetConflictError);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(3);
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
