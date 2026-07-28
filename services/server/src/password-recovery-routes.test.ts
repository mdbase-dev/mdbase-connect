import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { createDatabase } from "./db.js";
import {
  EmailDeliveryError,
  type EmailTransport,
  type TransactionalEmail
} from "./email.js";
import { PasswordAccountService } from "./password-auth.js";

const resources: Array<() => Promise<void>> = [];
const origin = "https://connect.example";

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("password recovery HTTP boundary", () => {
  it("advertises recovery, returns a generic response, and delivers a fragment-only reset link", async () => {
    let delivered: {
      message: TransactionalEmail;
      idempotencyKey: string;
    } | null = null;
    const send = vi.fn(async (
      message: TransactionalEmail,
      idempotencyKey: string
    ) => {
      delivered = { message, idempotencyKey };
      return { provider: "test", messageId: "message-1" };
    });
    const { app, db } = await fixture({ send });
    const config = await app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(config.json().password_recovery).toBe(true);

    const unknown = await requestReset(app, "unknown@example.com");
    const known = await requestReset(app, "PERSON@example.com");
    expect(known.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    expect(known.json()).toEqual({
      accepted: true,
      message: "If an account uses that email, a password reset link is on its way."
    });
    await eventually(() => delivered !== null);
    expect(send).toHaveBeenCalledTimes(1);
    const delivery = delivered as unknown as {
      message: TransactionalEmail;
      idempotencyKey: string;
    };
    expect(delivery.message.to).toBe("person@example.com");
    expect(delivery.idempotencyKey).toMatch(/^password-reset\//);
    const resetUrl = delivery.message.text
      .split("\n")
      .find((line) => line.startsWith(`${origin}/reset-password#reset=`));
    expect(resetUrl).toBeDefined();
    expect(new URL(resetUrl!).search).toBe("");
    expect(new URL(resetUrl!).hash).toMatch(/^#reset=rst_/);

    const stored = JSON.stringify(
      (await db.query(
        `SELECT token_hash, normalized_email
         FROM authentication_challenges`
      )).rows
    );
    expect(stored).not.toContain(
      new URLSearchParams(new URL(resetUrl!).hash.slice(1)).get("reset")
    );
  });

  it("replaces the password, signs out old sessions, and issues a secure current session", async () => {
    let message: TransactionalEmail | null = null;
    const { app, account } = await fixture({
      async send(next) {
        message = next;
        return { provider: "test", messageId: "message-1" };
      }
    });
    await requestReset(app, "person@example.com");
    await eventually(() => message !== null);
    const resetUrl = message!.text
      .split("\n")
      .find((line) => line.startsWith(`${origin}/reset-password#reset=`))!;
    const resetToken = new URLSearchParams(
      new URL(resetUrl).hash.slice(1)
    ).get("reset")!;

    const crossOrigin = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset",
      headers: { origin: "https://evil.example" },
      payload: {
        reset_token: resetToken,
        password: "a replacement private beta password"
      }
    });
    expect(crossOrigin.statusCode).toBe(403);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset",
      headers: { origin },
      payload: {
        reset_token: "rst_unknown",
        password: "a replacement private beta password"
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_password_reset");

    const reset = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset",
      headers: {
        origin,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0"
      },
      payload: {
        reset_token: resetToken,
        password: "a replacement private beta password"
      }
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().other_sessions_signed_out).toBe(true);
    const cookie = reset.cookies.find(
      ({ name }) => name === "__Host-mdbase_session"
    );
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax"
    });
    expect((await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: account.cookie }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${cookie!.name}=${cookie!.value}` }
    })).statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset",
      headers: { origin },
      payload: {
        reset_token: resetToken,
        password: "another replacement private beta password"
      }
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual(invalid.json());
  });

  it("does not reveal provider failures after accepting a recovery request", async () => {
    const { app, db } = await fixture({
      async send() {
        throw new EmailDeliveryError("rate_limit_exceeded", true, 429);
      }
    });
    const response = await requestReset(app, "person@example.com");
    expect(response.statusCode).toBe(202);
    await eventually(async () => Boolean((await db.query(
      `SELECT id FROM audit_events
       WHERE event_type = 'password_reset.delivery_failed'`
    )).rows[0]));
    const event = await db.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_events
       WHERE event_type = 'password_reset.delivery_failed'`
    );
    expect(event.rows[0]?.metadata).toEqual({
      provider: "resend",
      code: "rate_limit_exceeded",
      retryable: true
    });
  });

  it("requires shared abuse controls and a runtime email transport", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const policy = await configurePolicy(db);
    const { app } = await buildApp({
      db,
      publicUrl: origin,
      authRateLimitSecret: "test-auth-rate-limit-secret-value"
    });
    resources.push(() => app.close());
    expect((await app.inject({
      method: "GET",
      url: "/v1/auth/config"
    })).json().password_recovery).toBeUndefined();
    const unavailable = await requestReset(app, "person@example.com");
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("password_recovery_unavailable");
    await policy.update({
      registrationMode: "invite",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: false,
      termsVersion: "terms-2026-07",
      privacyVersion: "privacy-2026-07",
      expectedRevision: 1,
      updatedBy: "operator:test",
      reason: "Leave recovery disabled"
    });
  });

  it("rate-limits normalized addresses without storing raw account identifiers", async () => {
    const { app, db } = await fixture({
      async send() {
        return { provider: "test", messageId: "message" };
      }
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await requestReset(
        app,
        attempt % 2 ? "PERSON@example.com" : "person@example.com"
      )).statusCode).toBe(202);
    }
    const throttled = await requestReset(app, "PERSON@example.com");
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toMatch(/^[1-9][0-9]*$/);
    expect(JSON.stringify((await db.query(
      "SELECT key_digest FROM auth_rate_limit_buckets"
    )).rows)).not.toContain("person@example.com");
  });
});

async function fixture(emailTransport: EmailTransport) {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const policy = await configurePolicy(db);
  const passwordAccounts = new PasswordAccountService(db, policy);
  const invitation = await passwordAccounts.createInvitation({
    email: "person@example.com",
    actor: "operator:test",
    reason: "Create HTTP recovery fixture"
  });
  const account = await passwordAccounts.acceptInvitation({
    invitationToken: invitation.token,
    name: "Person Example",
    password: "the original private beta password",
    termsVersion: invitation.termsVersion,
    privacyVersion: invitation.privacyVersion
  });
  const { app } = await buildApp({
    db,
    publicUrl: origin,
    authRateLimitSecret: "test-auth-rate-limit-secret-value",
    emailTransport
  });
  resources.push(() => app.close());
  return {
    app,
    db,
    account: {
      ...account,
      cookie: `__Host-mdbase_session=${account.token}`
    }
  };
}

async function configurePolicy(
  db: Awaited<ReturnType<typeof createDatabase>>
) {
  const policy = new AuthenticationPolicyStore(db, "closed");
  await policy.update({
    registrationMode: "invite",
    passwordAuthEnabled: true,
    emailDeliveryEnabled: true,
    termsVersion: "terms-2026-07",
    privacyVersion: "privacy-2026-07",
    expectedRevision: 0,
    updatedBy: "operator:test",
    reason: "Configure password recovery routes"
  });
  return policy;
}

function requestReset(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  email: string
) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/password/recovery",
    headers: { origin },
    payload: { email }
  });
}

async function eventually(
  predicate: () => boolean | Promise<boolean>
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for asynchronous password recovery work.");
}
