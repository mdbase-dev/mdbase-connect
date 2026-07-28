import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { createDatabase } from "./db.js";
import { PasswordAccountService } from "./password-auth.js";

const resources: Array<() => Promise<void>> = [];
const origin = "https://connect.example";

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("password authentication HTTP boundary", () => {
  it("requires same-origin invitation acceptance and creates a usable secure session", async () => {
    const { app, db, invitation } = await fixture();
    const config = await app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(config.headers["cache-control"]).toBe("no-store");
    expect(config.json()).toMatchObject({
      registration: "invite",
      password_login: true,
      password_registration: true,
      agreements: {
        terms: {
          version: invitation.termsVersion,
          url: "https://mdbase.dev/terms/"
        },
        privacy: {
          version: invitation.privacyVersion,
          url: "https://mdbase.dev/privacy/"
        }
      }
    });
    const payload = {
      invitation_token: invitation.token,
      name: "Person Example",
      password: "a durable private beta password",
      terms_version: invitation.termsVersion,
      privacy_version: invitation.privacyVersion
    };
    const preview = await app.inject({
      method: "POST",
      url: "/v1/auth/password/invitation",
      headers: { origin },
      payload: { invitation_token: invitation.token }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.json().invitation).toMatchObject({
      email: "person@example.com",
      terms_version: invitation.termsVersion,
      privacy_version: invitation.privacyVersion
    });
    expect(preview.json().invitation.expires_at).toMatch(/Z$/);
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/v1/auth/password/signup",
      headers: { origin: "https://evil.example" },
      payload
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json().error.code).toBe("origin_denied");

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/auth/password/signup",
      headers: { origin },
      payload
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().user).toMatchObject({
      email: "person@example.com",
      name: "Person Example"
    });
    const sessionCookie = accepted.cookies.find(
      ({ name }) => name === "__Host-mdbase_session"
    );
    expect(sessionCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax"
    });

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        cookie: `${sessionCookie!.name}=${sessionCookie!.value}`
      }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(expect.objectContaining({
      user: expect.objectContaining({
        email: "person@example.com",
        name: "Person Example"
      }),
      authentication: {
        provider: "password",
        registration: "invite"
      }
    }));
    const rawLimits = JSON.stringify(
      (await db.query("SELECT * FROM auth_rate_limit_buckets")).rows
    );
    expect(rawLimits).not.toContain(invitation.token);
  });

  it("returns the same login failure for unknown, incorrect, and suspended accounts", async () => {
    const { app, db, invitation } = await fixture();
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/password/signup",
      headers: { origin },
      payload: {
        invitation_token: invitation.token,
        name: "Person Example",
        password: "a durable private beta password",
        terms_version: invitation.termsVersion,
        privacy_version: invitation.privacyVersion
      }
    });
    expect(signup.statusCode).toBe(201);

    const wrong = await login(app, "person@example.com", "the wrong beta password");
    const unknown = await login(app, "unknown@example.com", "the wrong beta password");
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());

    await db.query(
      `UPDATE users SET suspended_at = now()
       WHERE id = (SELECT user_id FROM email_identities
                   WHERE normalized_email = 'person@example.com')`
    );
    const suspended = await login(
      app,
      "person@example.com",
      "a durable private beta password"
    );
    expect(suspended.statusCode).toBe(401);
    expect(suspended.json()).toEqual(unknown.json());
  });

  it("does not reveal why an invitation cannot be used", async () => {
    const { app, passwordAccounts, invitation } = await fixture();
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/password/invitation",
      headers: { origin },
      payload: { invitation_token: "inv_unknown" }
    });
    expect(unknown.statusCode).toBe(400);
    await passwordAccounts.createInvitation({
      email: "person@example.com",
      actor: "operator:test",
      reason: "Reissue the HTTP test invitation"
    });
    const revoked = await app.inject({
      method: "POST",
      url: "/v1/auth/password/invitation",
      headers: { origin },
      payload: { invitation_token: invitation.token }
    });
    expect(revoked.statusCode).toBe(400);
    expect(revoked.json()).toEqual(unknown.json());
  });

  it("enforces shared email limits and stores only keyed digests", async () => {
    const { app, db } = await fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(
        app,
        "unknown@example.com",
        "the wrong beta password"
      );
      expect(response.statusCode).toBe(401);
    }
    const throttled = await login(
      app,
      "UNKNOWN@example.com",
      "the wrong beta password"
    );
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toMatch(/^[1-9][0-9]*$/);
    expect(throttled.json().error.code).toBe("authentication_throttled");

    const buckets = await db.query<{ key_digest: string }>(
      "SELECT key_digest FROM auth_rate_limit_buckets"
    );
    expect(buckets.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(buckets.rows)).not.toContain("unknown@example.com");
  });

  it("does not advertise or execute password auth without the shared limit secret", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const policy = await configurePolicy(db);
    const passwordAccounts = new PasswordAccountService(db, policy);
    const invitation = await passwordAccounts.createInvitation({
      email: "person@example.com",
      actor: "operator:test",
      reason: "Missing limiter configuration"
    });
    const { app } = await buildApp({ db, publicUrl: origin });
    resources.push(() => app.close());
    const config = await app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(config.json().password_login).toBeUndefined();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/signup",
      headers: { origin },
      payload: {
        invitation_token: invitation.token,
        name: "Person Example",
        password: "a durable private beta password",
        terms_version: invitation.termsVersion,
        privacy_version: invitation.privacyVersion
      }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("authentication_unavailable");
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(0);
  });

  it("keeps registration unavailable when legal documents are missing or mode is open", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const policy = await configurePolicy(db);
    const invitation = await new PasswordAccountService(
      db,
      policy
    ).createInvitation({
      email: "person@example.com",
      actor: "operator:test",
      reason: "Incomplete registration configuration"
    });
    const withoutDocuments = await buildApp({
      db,
      publicUrl: origin,
      authRateLimitSecret: "test-auth-rate-limit-secret-value"
    });
    resources.push(() => withoutDocuments.app.close());
    const incompleteConfig = await withoutDocuments.app.inject({
      method: "GET",
      url: "/v1/auth/config"
    });
    expect(incompleteConfig.json().password_login).toBe(true);
    expect(incompleteConfig.json().password_registration).toBeUndefined();
    const incompleteSignup = await withoutDocuments.app.inject({
      method: "POST",
      url: "/v1/auth/password/signup",
      headers: { origin },
      payload: {
        invitation_token: invitation.token,
        name: "Person Example",
        password: "a durable private beta password",
        terms_version: invitation.termsVersion,
        privacy_version: invitation.privacyVersion
      }
    });
    expect(incompleteSignup.statusCode).toBe(503);

    await policy.update({
      registrationMode: "open",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: false,
      termsVersion: invitation.termsVersion,
      privacyVersion: invitation.privacyVersion,
      expectedRevision: 1,
      updatedBy: "operator:test",
      reason: "Verify open mode cannot bypass email verification"
    });
    const withDocuments = await buildApp({
      db,
      publicUrl: origin,
      authRateLimitSecret: "test-auth-rate-limit-secret-value",
      authenticationLegalDocuments: {
        termsUrl: "https://mdbase.dev/terms/",
        privacyUrl: "https://mdbase.dev/privacy/"
      }
    });
    resources.push(() => withDocuments.app.close());
    const openConfig = await withDocuments.app.inject({
      method: "GET",
      url: "/v1/auth/config"
    });
    expect(openConfig.json().registration).toBe("open");
    expect(openConfig.json().password_login).toBe(true);
    expect(openConfig.json().password_registration).toBeUndefined();
    const openSignup = await withDocuments.app.inject({
      method: "POST",
      url: "/v1/auth/password/signup",
      headers: { origin },
      payload: {
        invitation_token: invitation.token,
        name: "Person Example",
        password: "a durable private beta password",
        terms_version: invitation.termsVersion,
        privacy_version: invitation.privacyVersion
      }
    });
    expect(openSignup.statusCode).toBe(503);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(0);
  });
});

async function fixture() {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const policy = await configurePolicy(db);
  const passwordAccounts = new PasswordAccountService(db, policy);
  const invitation = await passwordAccounts.createInvitation({
    email: "person@example.com",
    actor: "operator:test",
    reason: "HTTP authentication test"
  });
  const { app } = await buildApp({
    db,
    publicUrl: origin,
    authRateLimitSecret: "test-auth-rate-limit-secret-value",
    authenticationLegalDocuments: {
      termsUrl: "https://mdbase.dev/terms/",
      privacyUrl: "https://mdbase.dev/privacy/"
    }
  });
  resources.push(() => app.close());
  return { app, db, policy, passwordAccounts, invitation };
}

async function configurePolicy(db: Awaited<ReturnType<typeof createDatabase>>) {
  const policy = new AuthenticationPolicyStore(db, "closed");
  await policy.update({
    registrationMode: "invite",
    passwordAuthEnabled: true,
    emailDeliveryEnabled: false,
    termsVersion: "terms-2026-07",
    privacyVersion: "privacy-2026-07",
    expectedRevision: 0,
    updatedBy: "operator:test",
    reason: "Configure password route tests"
  });
  return policy;
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  email: string,
  password: string
) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/password/login",
    headers: { origin },
    payload: { email, password }
  });
}
