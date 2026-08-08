import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { buildApp } from "./app.js";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { createDatabase } from "./db.js";
import {
  GoogleIdentityError,
  verifyGoogleCredential,
  type GoogleAuthConfig
} from "./google-auth.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (resources.length) await resources.pop()?.();
});

describe("Google authentication", () => {
  it("binds a verified Google identity to a one-time browser nonce and session", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const verifyCredential = vi.fn(async () => ({
      id: "109876543210",
      name: "Ada Example",
      email: "ada@example.com",
      emailVerified: true,
      avatarUrl: "https://example.com/ada.png"
    }));
    const { app } = await buildApp({
      db,
      publicUrl: "https://connect.example",
      googleAuth: {
        clientId: "google-client.apps.googleusercontent.com",
        allowedSubjects: new Set(["109876543210"]),
        verifyCredential
      }
    });
    resources.push(() => app.close());

    const config = await app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(config.json()).toEqual({
      provider: "google",
      providers: [{ id: "google", label: "Continue with Google", login_url: "/auth/google" }],
      registration: "closed",
      development_login: false,
      login_url: "/auth/google"
    });
    expect(config.headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
    expect(config.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(config.headers["content-security-policy"]).toContain(
      "script-src 'self' https://accounts.google.com/gsi/client"
    );
    expect(config.headers["content-security-policy"]).toContain(
      "frame-src https://accounts.google.com/gsi/"
    );

    const started = await app.inject({
      method: "GET",
      url: "/auth/google?return_to=https%3A%2F%2Fconnect.example%2Fpair%2F123"
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({
      client_id: "google-client.apps.googleusercontent.com",
      nonce: expect.stringMatching(/^nonce_/)
    });
    expect(started.headers["cache-control"]).toBe("no-store");
    const oauthCookie = responseCookies(started)
      .find((value) => value.startsWith("__Host-mdbase_oauth_google="))!;

    const crossOrigin = await app.inject({
      method: "POST",
      url: "/auth/google/callback",
      headers: {
        cookie: cookiePair(oauthCookie),
        origin: "https://evil.example",
        "x-mdbase-auth": "google"
      },
      payload: { credential: "credential".repeat(20) }
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(verifyCredential).not.toHaveBeenCalled();

    const completed = await app.inject({
      method: "POST",
      url: "/auth/google/callback",
      headers: {
        cookie: cookiePair(oauthCookie),
        origin: "https://connect.example",
        "x-mdbase-auth": "google"
      },
      payload: { credential: "credential".repeat(20) }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ redirect_to: "/pair/123" });
    expect(verifyCredential).toHaveBeenCalledWith({
      credential: "credential".repeat(20),
      nonce: started.json().nonce
    });
    const sessionCookie = responseCookies(completed)
      .find((value) => value.startsWith("__Host-mdbase_session="))!;

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: cookiePair(sessionCookie) }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(expect.objectContaining({
      user: expect.objectContaining({
        name: "Ada Example",
        email: "ada@example.com",
        login: null
      }),
      authentication: { provider: "google", registration: "closed" }
    }));

    const identity = await db.query<{
      provider: string;
      subject: string;
      email_verified: boolean;
      avatar_url: string;
    }>("SELECT provider, subject, email_verified, avatar_url FROM external_identities");
    expect(identity.rows[0]).toEqual({
      provider: "google",
      subject: "109876543210",
      email_verified: true,
      avatar_url: "https://example.com/ada.png"
    });

    const replay = await app.inject({
      method: "POST",
      url: "/auth/google/callback",
      headers: {
        cookie: cookiePair(oauthCookie),
        origin: "https://connect.example",
        "x-mdbase-auth": "google"
      },
      payload: { credential: "credential".repeat(20) }
    });
    expect(replay.statusCode).toBe(400);
    expect(verifyCredential).toHaveBeenCalledTimes(1);
  });

  it("keeps closed registration allowlisted and applies an audited policy change without restart", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const identity = {
      id: "222222222222",
      name: "New User",
      email: "new@example.com",
      emailVerified: true,
      avatarUrl: null
    };
    const { app: closed } = await buildApp({
      db,
      publicUrl: "https://connect.example",
      googleAuth: {
        clientId: "google-client.apps.googleusercontent.com",
        allowedSubjects: new Set(["111111111111"]),
        verifyCredential: async () => identity
      }
    });
    resources.push(() => closed.close());
    const closedStart = await closed.inject({ method: "GET", url: "/auth/google" });
    const denied = await googleCallback(closed, closedStart);
    expect(denied.statusCode).toBe(403);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(0);

    const policy = new AuthenticationPolicyStore(db, "closed");
    await policy.update({
      registrationMode: "open",
      passwordAuthEnabled: false,
      emailDeliveryEnabled: false,
      termsVersion: null,
      privacyVersion: null,
      expectedRevision: 0,
      updatedBy: "operator:test",
      reason: "Exercise dynamic registration"
    });
    const config = await closed.inject({ method: "GET", url: "/v1/auth/config" });
    expect(config.json().registration).toBe("open");

    const openStart = await closed.inject({ method: "GET", url: "/auth/google" });
    const admitted = await googleCallback(closed, openStart);
    expect(admitted.statusCode).toBe(200);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);

    await policy.update({
      registrationMode: "invite",
      passwordAuthEnabled: false,
      emailDeliveryEnabled: false,
      termsVersion: null,
      privacyVersion: null,
      expectedRevision: 1,
      updatedBy: "operator:test",
      reason: "Return to invite-only registration"
    });
    const linkedStart = await closed.inject({ method: "GET", url: "/auth/google" });
    const linkedLogin = await googleCallback(closed, linkedStart);
    expect(linkedLogin.statusCode).toBe(200);
    expect((await db.query("SELECT id FROM users")).rows).toHaveLength(1);
  });

  it("passes credentials and nonce through an injected verifier", async () => {
    const verifyCredential = vi.fn(async () => ({
      id: "123",
      name: "Test",
      email: null,
      emailVerified: false,
      avatarUrl: null
    }));
    const config: GoogleAuthConfig = {
      clientId: "client.apps.googleusercontent.com",
      allowedSubjects: new Set(),
      verifyCredential
    };
    await expect(verifyGoogleCredential(config, {
      credential: "signed-token",
      nonce: "one-time-nonce"
    })).resolves.toEqual(expect.objectContaining({ id: "123" }));
    expect(verifyCredential).toHaveBeenCalledWith({
      credential: "signed-token",
      nonce: "one-time-nonce"
    });
  });

  it("checks the Google token audience and one-time nonce", async () => {
    const verifyIdToken = vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({
        sub: "109876543210",
        nonce: "one-time-nonce",
        name: "Verified User",
        email: "verified@example.com",
        email_verified: true,
        picture: "https://example.com/verified.png"
      })
    } as never);
    const config: GoogleAuthConfig = {
      clientId: "client.apps.googleusercontent.com",
      allowedSubjects: new Set()
    };

    await expect(verifyGoogleCredential(config, {
      credential: "signed-token",
      nonce: "one-time-nonce"
    })).resolves.toEqual({
      id: "109876543210",
      name: "Verified User",
      email: "verified@example.com",
      emailVerified: true,
      avatarUrl: "https://example.com/verified.png"
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "signed-token",
      audience: "client.apps.googleusercontent.com"
    });

    await expect(verifyGoogleCredential(config, {
      credential: "signed-token",
      nonce: "different-nonce"
    })).rejects.toBeInstanceOf(GoogleIdentityError);
  });
});

async function googleCallback(
  app: { inject(input: Record<string, unknown>): Promise<any> },
  started: { headers: Record<string, string | string[] | undefined> }
) {
  const oauthCookie = responseCookies(started)
    .find((value) => value.startsWith("__Host-mdbase_oauth_google="))!;
  return app.inject({
    method: "POST",
    url: "/auth/google/callback",
    headers: {
      cookie: cookiePair(oauthCookie),
      origin: "https://connect.example",
      "x-mdbase-auth": "google"
    },
    payload: { credential: "credential".repeat(20) }
  });
}

function responseCookies(response: { headers: Record<string, string | string[] | undefined> }): string[] {
  const value = response.headers["set-cookie"];
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

function cookiePair(value: string): string {
  return value.split(";", 1)[0];
}
