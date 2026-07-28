import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { createDatabase, type DatabasePool } from "./db.js";
import { PasswordAccountService } from "./password-auth.js";
import {
  InvalidPasswordResetError,
  PasswordRecoveryService,
  PasswordRecoveryUnavailableError
} from "./password-recovery.js";
import { tokenHash } from "./security.js";
import { verifyPassword } from "./password.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("password recovery", () => {
  it("creates one active hashed reset challenge only for a verified password account", async () => {
    const { db, recovery } = await fixture();
    await expect(recovery.create("unknown@example.com")).resolves.toBeNull();
    expect((await db.query(
      "SELECT id FROM authentication_challenges"
    )).rows).toHaveLength(0);

    const first = await recovery.create("PERSON@example.com");
    expect(first).toMatchObject({
      email: "person@example.com"
    });
    expect(first?.token).toMatch(/^rst_/);
    const stored = await db.query<{
      token_hash: string;
      invalidated_at: Date | null;
    }>(
      `SELECT token_hash, invalidated_at
       FROM authentication_challenges WHERE id = $1`,
      [first!.challengeId]
    );
    expect(stored.rows[0]).toMatchObject({
      token_hash: tokenHash(first!.token),
      invalidated_at: null
    });
    expect(JSON.stringify(stored.rows[0])).not.toContain(first!.token);

    const replacement = await recovery.create("person@example.com");
    expect(replacement?.challengeId).not.toBe(first?.challengeId);
    const challenges = await db.query<{
      id: string;
      invalidated_at: Date | null;
    }>(
      `SELECT id, invalidated_at FROM authentication_challenges
       ORDER BY created_at`
    );
    expect(challenges.rows).toHaveLength(2);
    expect(challenges.rows.find(({ id }) => id === first?.challengeId)
      ?.invalidated_at).not.toBeNull();
    expect(challenges.rows.find(({ id }) => id === replacement?.challengeId)
      ?.invalidated_at).toBeNull();
  });

  it("atomically rotates the credential, account epoch, and browser sessions", async () => {
    const { db, passwordAccounts, recovery, account } = await fixture();
    const reset = await recovery.create("person@example.com");
    const recovered = await recovery.complete({
      token: reset!.token,
      password: "a replacement private beta password",
      clientName: "Firefox on Linux"
    });
    expect(recovered.user).toEqual(account.user);
    expect(recovered.token).toMatch(/^ses_/);

    const credential = await db.query<{
      password_hash: string;
      credential_version: number;
    }>(
      `SELECT password_hash, credential_version
       FROM password_credentials WHERE user_id = $1`,
      [account.user.id]
    );
    expect(await verifyPassword(
      credential.rows[0]!.password_hash,
      "a replacement private beta password"
    )).toBe(true);
    expect(await verifyPassword(
      credential.rows[0]!.password_hash,
      "the original private beta password"
    )).toBe(false);
    expect(credential.rows[0]?.credential_version).toBe(2);

    const state = await db.query<{
      session_epoch: number;
      token_hash: string;
      account_session_epoch: number;
      revoked_at: Date | null;
      client_name: string | null;
    }>(
      `SELECT u.session_epoch, s.token_hash, s.account_session_epoch,
              s.revoked_at, s.client_name
       FROM users u JOIN sessions s ON s.user_id = u.id
       WHERE u.id = $1 ORDER BY s.created_at`,
      [account.user.id]
    );
    expect(state.rows).toHaveLength(2);
    expect(state.rows.every(({ session_epoch }) => session_epoch === 2)).toBe(true);
    expect(state.rows.find(({ token_hash }) => token_hash === tokenHash(account.token))
      ?.revoked_at).not.toBeNull();
    expect(state.rows.find(({ token_hash }) => token_hash === tokenHash(recovered.token)))
      .toMatchObject({
        account_session_epoch: 2,
        revoked_at: null,
        client_name: "Firefox on Linux"
      });
    await expect(recovery.complete({
      token: reset!.token,
      password: "another replacement private beta password",
      clientName: "Browser session"
    })).rejects.toBeInstanceOf(InvalidPasswordResetError);
    await expect(passwordAccounts.authenticate({
      email: account.user.email,
      password: "the original private beta password"
    })).rejects.toThrow(/incorrect/);
    await expect(passwordAccounts.authenticate({
      email: account.user.email,
      password: "a replacement private beta password"
    })).resolves.toMatchObject({ user: account.user });
  });

  it("allows only one concurrent redemption and leaves no partial credential update", async () => {
    const { recovery } = await fixture();
    const reset = await recovery.create("person@example.com");
    const outcomes = await Promise.allSettled([
      recovery.complete({
        token: reset!.token,
        password: "the first concurrent reset password",
        clientName: "Browser one"
      }),
      recovery.complete({
        token: reset!.token,
        password: "the second concurrent reset password",
        clientName: "Browser two"
      })
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("honours password and email-delivery kill switches at their boundaries", async () => {
    const { policy, recovery } = await fixture();
    await policy.update({
      registrationMode: "invite",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: false,
      termsVersion: "terms-2026-07",
      privacyVersion: "privacy-2026-07",
      expectedRevision: 1,
      updatedBy: "operator:test",
      reason: "Disable email delivery"
    });
    await expect(recovery.create("person@example.com"))
      .rejects.toBeInstanceOf(PasswordRecoveryUnavailableError);

    await policy.update({
      registrationMode: "invite",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: true,
      termsVersion: "terms-2026-07",
      privacyVersion: "privacy-2026-07",
      expectedRevision: 2,
      updatedBy: "operator:test",
      reason: "Restore email delivery"
    });
    const reset = await recovery.create("person@example.com");
    await policy.update({
      registrationMode: "invite",
      passwordAuthEnabled: false,
      emailDeliveryEnabled: true,
      termsVersion: "terms-2026-07",
      privacyVersion: "privacy-2026-07",
      expectedRevision: 3,
      updatedBy: "operator:test",
      reason: "Disable password authentication"
    });
    await expect(recovery.complete({
      token: reset!.token,
      password: "a replacement private beta password",
      clientName: "Browser session"
    })).rejects.toBeInstanceOf(PasswordRecoveryUnavailableError);
  });

  it("records provider outcomes without storing the reset token", async () => {
    const { db, recovery } = await fixture();
    const reset = await recovery.create("person@example.com");
    await recovery.recordDelivery(reset!.challengeId, reset!.userId, {
      status: "sent",
      provider: "resend",
      messageId: "message-1"
    });
    const events = await db.query<{ event_type: string; metadata: unknown }>(
      `SELECT event_type, metadata FROM audit_events
       WHERE subject_id = $1 ORDER BY created_at`,
      [reset!.challengeId]
    );
    expect(events.rows.map(({ event_type }) => event_type)).toEqual([
      "password_reset.requested",
      "password_reset.sent"
    ]);
    expect(JSON.stringify(events.rows)).not.toContain(reset!.token);
  });
});

async function fixture(): Promise<{
  db: DatabasePool;
  policy: AuthenticationPolicyStore;
  passwordAccounts: PasswordAccountService;
  recovery: PasswordRecoveryService;
  account: Awaited<ReturnType<PasswordAccountService["acceptInvitation"]>>;
}> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const policy = new AuthenticationPolicyStore(db, "closed");
  await policy.update({
    registrationMode: "invite",
    passwordAuthEnabled: true,
    emailDeliveryEnabled: true,
    termsVersion: "terms-2026-07",
    privacyVersion: "privacy-2026-07",
    expectedRevision: 0,
    updatedBy: "operator:test",
    reason: "Configure password recovery tests"
  });
  const passwordAccounts = new PasswordAccountService(db, policy);
  const invitation = await passwordAccounts.createInvitation({
    email: "person@example.com",
    actor: "operator:test",
    reason: "Create password recovery fixture"
  });
  const account = await passwordAccounts.acceptInvitation({
    invitationToken: invitation.token,
    name: "Person Example",
    password: "the original private beta password",
    termsVersion: invitation.termsVersion,
    privacyVersion: invitation.privacyVersion,
    clientName: "Chrome on macOS"
  });
  return {
    db,
    policy,
    passwordAccounts,
    recovery: new PasswordRecoveryService(db, policy),
    account
  };
}
