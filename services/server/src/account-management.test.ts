import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { hashPassword } from "./password.js";
import { tokenHash } from "./security.js";
import type { HostedProviderClient } from "./hosted-provider.js";

const resources: Array<() => Promise<void>> = [];
const origin = "https://connect.example";
const editorOrigin = "https://editor.example";
const oldPassword = "a correct old password";
const newPassword = "a much better new password";

afterEach(async () => {
  vi.restoreAllMocks();
  while (resources.length) await resources.pop()?.();
});

describe("account management", () => {
  it("reports hosted-only usage, quotas, sign-in methods, and deletion impact", async () => {
    const usage = vi.fn(async (collectionId: string) => ({
      collection_id: collectionId,
      record_count: 12,
      content_bytes: 4_096,
      max_records: 100_000,
      max_content_bytes: 1_073_741_824,
      max_document_bytes: 2_097_152,
      file_count: 0,
      file_bytes: 0,
      stored_file_bytes: 0,
      max_files: 10_000,
      max_file_bytes: 1_073_741_824,
      max_stored_file_bytes: 2_147_483_648,
      max_single_file_bytes: 262_144_000
    }));
    const { app, db } = await fixture({
      hostedCollections: true,
      hostedProvider: fakeProvider({ collectionUsage: usage })
    });
    const account = await seedSession(db);
    await seedPassword(db, account.userId, account.email, oldPassword);
    await db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, contracts)
       VALUES ($1, $2, 'Research', 'mdbase', '[]'::jsonb)`,
      [randomUUID(), account.userId]
    );
    await db.query(
      `INSERT INTO external_identities
         (provider, subject, user_id, login, email, email_verified)
       VALUES ('github', '12345', $1, 'person', NULL, false)`,
      [account.userId]
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/account",
      headers: { cookie: account.cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(expect.objectContaining({
      authentication: expect.objectContaining({
        current_provider: "session",
        identities: [expect.objectContaining({
          provider: "github",
          login: "person",
          current: false,
          removable: true
        })],
        password: expect.objectContaining({
          configured: true,
          email: account.email,
          change_available: true
        })
      }),
      storage: {
        status: "available",
        total_content_bytes: 4_096,
        total_file_bytes: 0,
        total_storage_bytes: 4_096,
        total_stored_file_bytes: 0,
        total_records: 12,
        collections: [expect.objectContaining({
          display_name: "Research",
          usage: expect.objectContaining({ max_content_bytes: 1_073_741_824 })
        })]
      },
      deletion: expect.objectContaining({ hosted_collections: 1 })
    }));
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it("changes a password, preserves only the current session, and accepts only the new password", async () => {
    const { app, db } = await fixture();
    const first = await seedSession(db);
    const current = await seedSession(db, {
      userId: first.userId,
      email: first.email,
      clientName: "Current browser"
    });
    await seedPassword(db, first.userId, first.email, oldPassword);

    const wrong = await app.inject({
      method: "PATCH",
      url: "/v1/account/password",
      headers: { cookie: current.cookie, origin },
      payload: { current_password: "not the password", new_password: newPassword }
    });
    expect(wrong.statusCode).toBe(401);

    const changed = await app.inject({
      method: "PATCH",
      url: "/v1/account/password",
      headers: { cookie: current.cookie, origin },
      payload: { current_password: oldPassword, new_password: newPassword }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ ok: true, other_sessions_signed_out: true });
    expect((await app.inject({
      method: "GET", url: "/v1/me", headers: { cookie: first.cookie }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET", url: "/v1/me", headers: { cookie: current.cookie }
    })).statusCode).toBe(200);
    expect((await passwordLogin(app, first.email, oldPassword)).statusCode).toBe(401);
    expect((await passwordLogin(app, first.email, newPassword)).statusCode).toBe(200);
  });

  it("allows account mutations only from the server or an explicit management origin", async () => {
    const { app, db } = await fixture({ managementOrigins: [editorOrigin] });
    const account = await seedSession(db);
    await seedPassword(db, account.userId, account.email, oldPassword);

    const denied = await app.inject({
      method: "PATCH",
      url: "/v1/account/password",
      headers: { cookie: account.cookie, origin: "https://evil.example" },
      payload: { current_password: oldPassword, new_password: newPassword }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("origin_denied");

    const allowed = await app.inject({
      method: "PATCH",
      url: "/v1/account/password",
      headers: { cookie: account.cookie, origin: editorOrigin },
      payload: { current_password: oldPassword, new_password: newPassword }
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("links an explicitly authenticated GitHub identity without creating or merging accounts", async () => {
    const { app, db } = await fixture({
      githubAuth: {
        ...githubConfig({ id: "12558714", login: "callumalpass" }),
        allowedUserIds: new Set<string>()
      }
    });
    await db.query(
      "UPDATE authentication_settings SET registration_mode = 'closed' WHERE singleton = true"
    );
    const account = await seedSession(db);
    const started = await app.inject({
      method: "GET",
      url: "/v1/account/identities/github/link?return_to=%2Faccount",
      headers: { cookie: account.cookie }
    });
    expect(started.statusCode).toBe(302);
    const authorization = new URL(started.headers.location!);
    expect(authorization.searchParams.get("allow_signup")).toBe("false");
    const completed = await completeGitHubFlow(app, started, account.cookie);
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe("/account?linked=github");
    const users = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
    expect(users.rows[0]?.count).toBe("1");
    const identity = await db.query<{ user_id: string; login: string }>(
      "SELECT user_id, login FROM external_identities WHERE provider = 'github'"
    );
    expect(identity.rows[0]).toEqual({ user_id: account.userId, login: "callumalpass" });
  });

  it("links a Google identity to the initiating account in closed registration mode", async () => {
    const verifyCredential = vi.fn(async () => ({
      id: "google-subject-1",
      name: "Person Example",
      email: "person@gmail.com",
      emailVerified: true,
      avatarUrl: null
    }));
    const { app, db } = await fixture({
      managementOrigins: [editorOrigin],
      googleAuth: {
        clientId: "google-client-id.apps.googleusercontent.com",
        allowedSubjects: new Set<string>(),
        verifyCredential
      }
    });
    await db.query(
      "UPDATE authentication_settings SET registration_mode = 'closed' WHERE singleton = true"
    );
    const account = await seedSession(db);
    await seedSession(db, { email: "person@gmail.com" });
    const started = await app.inject({
      method: "GET",
      url: "/v1/account/identities/google/link?return_to=%2Faccount",
      headers: { cookie: account.cookie }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({
      client_id: "google-client-id.apps.googleusercontent.com",
      nonce: expect.stringMatching(/^nonce_/)
    });
    const oauthCookie = responseCookies(started)
      .find((value) => value.includes("mdbase_oauth_google="))!;
    const completed = await app.inject({
      method: "POST",
      url: "/auth/google/callback",
      headers: {
        cookie: `${account.cookie}; ${cookiePair(oauthCookie)}`,
        origin: editorOrigin,
        "x-mdbase-auth": "google"
      },
      payload: { credential: "credential".repeat(20) }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual({ redirect_to: "/account?linked=google" });
    expect(verifyCredential).toHaveBeenCalledWith(expect.objectContaining({
      credential: "credential".repeat(20),
      nonce: started.json().nonce
    }));
    const identity = await db.query<{ user_id: string; normalized_email: string }>(
      "SELECT user_id, normalized_email FROM external_identities WHERE provider = 'google'"
    );
    expect(identity.rows[0]).toEqual({
      user_id: account.userId,
      normalized_email: "person@gmail.com"
    });
    const users = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users"
    );
    expect(users.rows[0]?.count).toBe("2");
  });

  it("binds an identity-link callback to the exact browser session that started it", async () => {
    const { app, db } = await fixture({
      githubAuth: githubConfig({ id: "12558714", login: "callumalpass" })
    });
    const first = await seedSession(db);
    const second = await seedSession(db, {
      userId: first.userId,
      email: first.email,
      clientName: "Other browser"
    });
    const started = await app.inject({
      method: "GET",
      url: "/v1/account/identities/github/link?return_to=%2Faccount",
      headers: { cookie: first.cookie }
    });
    const rejected = await completeGitHubFlow(app, started, second.cookie);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().error.code).toBe("account_reauthentication_required");
    const identities = await db.query("SELECT subject FROM external_identities");
    expect(identities.rows).toEqual([]);
  });

  it("refuses identity takeover, current-method removal, and removal of the final method", async () => {
    const { app, db } = await fixture({
      githubAuth: githubConfig({ id: "999", login: "claimed" })
    });
    const owner = await seedSession(db, { email: "owner@example.com" });
    const other = await seedSession(db, { email: "other@example.com" });
    await db.query(
      `INSERT INTO external_identities
         (provider, subject, user_id, login, email, email_verified)
       VALUES ('github', '999', $1, 'claimed', NULL, false)`,
      [owner.userId]
    );
    const started = await app.inject({
      method: "GET",
      url: "/v1/account/identities/github/link?return_to=%2Faccount",
      headers: { cookie: other.cookie }
    });
    const conflict = await completeGitHubFlow(app, started, other.cookie);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("identity_already_connected");

    const finalMethod = await app.inject({
      method: "DELETE",
      url: "/v1/account/identities/github",
      headers: { cookie: owner.cookie, origin }
    });
    expect(finalMethod.statusCode).toBe(409);
    expect(finalMethod.json().error.code).toBe("last_identity");

    await seedPassword(db, owner.userId, owner.email, oldPassword);
    const githubSession = await seedSession(db, {
      userId: owner.userId,
      email: owner.email,
      provider: "github"
    });
    const currentMethod = await app.inject({
      method: "DELETE",
      url: "/v1/account/identities/github",
      headers: { cookie: githubSession.cookie, origin }
    });
    expect(currentMethod.statusCode).toBe(409);
    expect(currentMethod.json().error.code).toBe("current_identity");
  });

  it("requires fresh external reauthentication, deletes hosted data first, and preserves local files semantically", async () => {
    const deleteCollection = vi.fn(async () => undefined);
    const { app, db } = await fixture({
      githubAuth: githubConfig({ id: "12558714", login: "callumalpass" }),
      hostedCollections: true,
      hostedProvider: fakeProvider({ deleteCollection })
    });
    const account = await seedSession(db);
    await db.query(
      `INSERT INTO external_identities
         (provider, subject, user_id, login, email, email_verified)
       VALUES ('github', '12558714', $1, 'callumalpass', NULL, false)`,
      [account.userId]
    );
    const hostedId = randomUUID();
    await db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, contracts)
       VALUES ($1, $2, 'Only hosted copy', 'mdbase', '[]'::jsonb)`,
      [hostedId, account.userId]
    );

    const unconfirmed = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: { cookie: account.cookie, origin },
      payload: { confirmation: "DELETE" }
    });
    expect(unconfirmed.statusCode).toBe(403);
    expect(deleteCollection).not.toHaveBeenCalled();

    const started = await app.inject({
      method: "GET",
      url: "/v1/account/reauth/github?return_to=%2Faccount",
      headers: { cookie: account.cookie }
    });
    const reauthenticated = await completeGitHubFlow(app, started, account.cookie);
    const redirect = new URL(reauthenticated.headers.location!, origin);
    const token = new URLSearchParams(redirect.hash.slice(1)).get("delete_token")!;
    expect(token).toMatch(/^act_/);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: { cookie: account.cookie, origin },
      payload: { confirmation: "DELETE", reauth_token: token }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleteCollection).toHaveBeenCalledWith(hostedId);
    expect((await db.query("SELECT id FROM users WHERE id = $1", [account.userId])).rows).toEqual([]);
    const event = await db.query<{ user_id: string | null; metadata: Record<string, number> }>(
      "SELECT user_id, metadata FROM audit_events WHERE event_type = 'account.deleted'"
    );
    expect(event.rows[0]).toEqual({
      user_id: null,
      metadata: { hosted_collections_deleted: 1, local_collections_preserved: 0 }
    });
    expect(responseCookies(deleted).join("\n")).toContain("Max-Age=0");
  });

  it("keeps the account intact when hosted-provider deletion fails", async () => {
    const { app, db } = await fixture({
      hostedCollections: true,
      hostedProvider: fakeProvider({
        deleteCollection: vi.fn(async () => { throw new Error("provider offline"); })
      })
    });
    const account = await seedSession(db);
    await seedPassword(db, account.userId, account.email, oldPassword);
    await db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, contracts)
       VALUES ($1, $2, 'Important', 'mdbase', '[]'::jsonb)`,
      [randomUUID(), account.userId]
    );
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: { cookie: account.cookie, origin },
      payload: { confirmation: "DELETE", current_password: oldPassword }
    });
    expect(response.statusCode).toBe(500);
    expect((await db.query("SELECT id FROM users WHERE id = $1", [account.userId])).rows)
      .toHaveLength(1);
  });
});

async function fixture(options: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  await db.query(
    `INSERT INTO authentication_settings
       (singleton, registration_mode, password_auth_enabled,
        email_delivery_enabled, revision, updated_by, update_reason)
     VALUES (true, 'open', true, false, 1, 'test', 'account tests')`
  );
  const { app } = await buildApp({
    db,
    publicUrl: origin,
    registration: "open",
    authRateLimitSecret: "account-test-rate-limit-secret-with-32-bytes",
    ...options
  });
  resources.push(() => app.close());
  return { app, db };
}

async function seedSession(
  db: Awaited<ReturnType<typeof createDatabase>>,
  options: {
    userId?: string;
    email?: string;
    provider?: string;
    clientName?: string;
  } = {}
) {
  const userId = options.userId ?? randomUUID();
  const email = options.email ?? "person@example.com";
  if (!options.userId) {
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, $2, 'Person Example')",
      [userId, email]
    );
  }
  const token = `ses_${randomUUID()}_${randomUUID()}`;
  await db.query(
    `INSERT INTO sessions
       (id, user_id, token_hash, provider, account_session_epoch,
        expires_at, client_name)
     SELECT $1, id, $3, $4, session_epoch,
            now() + interval '30 days', $5
     FROM users WHERE id = $2`,
    [randomUUID(), userId, tokenHash(token), options.provider ?? "session", options.clientName ?? "Test browser"]
  );
  return { userId, email, cookie: `__Host-mdbase_session=${token}` };
}

async function seedPassword(
  db: Awaited<ReturnType<typeof createDatabase>>,
  userId: string,
  email: string,
  password: string
) {
  await db.query(
    `INSERT INTO email_identities
       (id, user_id, email, normalized_email, verified_at, is_primary)
     VALUES ($1, $2, $3, $3, now(), true)`,
    [randomUUID(), userId, email]
  );
  await db.query(
    "INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)",
    [userId, await hashPassword(password)]
  );
}

function githubConfig(identity: { id: string; login: string }) {
  return {
    clientId: "github-client-id",
    clientSecret: "github-client-secret",
    allowedUserIds: new Set([identity.id]),
    exchangeCode: async () => ({ ...identity, name: "Linked Person", email: null })
  };
}

function fakeProvider(overrides: Record<string, unknown> = {}): HostedProviderClient {
  return {
    url: "https://provider.example",
    collectionUsage: async (collectionId: string) => ({
      collection_id: collectionId,
      record_count: 0,
      content_bytes: 0,
      max_records: 100_000,
      max_content_bytes: 1_073_741_824,
      max_document_bytes: 2_097_152
    }),
    deleteCollection: async () => undefined,
    revokeReplica: async () => undefined,
    ...overrides
  } as unknown as HostedProviderClient;
}

async function completeGitHubFlow(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  started: Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>["app"]["inject"]>>,
  sessionCookie: string
) {
  const authorization = new URL(started.headers.location!);
  const state = authorization.searchParams.get("state")!;
  const oauthCookie = responseCookies(started)
    .find((value) => value.includes("mdbase_oauth_github="))!;
  return app.inject({
    method: "GET",
    url: `/auth/github/callback?code=code-1&state=${encodeURIComponent(state)}`,
    headers: { cookie: `${sessionCookie}; ${cookiePair(oauthCookie)}` }
  });
}

async function passwordLogin(
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

function responseCookies(response: { headers: Record<string, string | string[] | undefined> }): string[] {
  const value = response.headers["set-cookie"];
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

function cookiePair(value: string): string {
  return value.split(";", 1)[0];
}
