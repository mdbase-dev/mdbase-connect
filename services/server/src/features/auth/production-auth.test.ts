import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import { tokenHash } from "../../security.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (resources.length) await resources.pop()?.();
});

describe("production GitHub authentication", () => {
  it("uses state, a browser-bound cookie, PKCE, an allowlist, and a one-time login", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const exchangeCode = vi.fn(async () => ({
      id: "12558714",
      login: "callumalpass",
      name: "Callum",
      email: null,
      emailVerified: false
    }));
    const { app } = await buildApp({
      db,
      publicUrl: "https://connect.example",
      githubAuth: {
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
        allowedUserIds: new Set(["12558714"]),
        exchangeCode
      }
    });
    resources.push(() => app.close());

    const config = await app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(config.json()).toEqual({
      provider: "github",
      providers: [{ id: "github", label: "Continue with GitHub", login_url: "/auth/github" }],
      registration: "closed",
      development_login: false,
      login_url: "/auth/github"
    });

    const started = await app.inject({
      method: "GET",
      url: "/auth/github?return_to=https%3A%2F%2Fconnect.example%2Fpair%2F123"
    });
    expect(started.statusCode).toBe(302);
    const authorization = new URL(started.headers.location!);
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.pathname).toBe("/login/oauth/authorize");
    expect(authorization.searchParams.get("client_id")).toBe("github-client-id");
    expect(authorization.searchParams.get("redirect_uri"))
      .toBe("https://connect.example/auth/github/callback");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("allow_signup")).toBe("false");
    const state = authorization.searchParams.get("state")!;
    const oauthCookie = responseCookies(started)
      .find((value) => value.startsWith("__Host-mdbase_oauth_github="))!;
    expect(oauthCookie).toContain("HttpOnly");
    expect(oauthCookie).toContain("Secure");
    expect(oauthCookie.toLowerCase()).toContain("samesite=lax");

    const missingCookie = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=code-1&state=${encodeURIComponent(state)}`
    });
    expect(missingCookie.statusCode).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();

    const completed = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookiePair(oauthCookie) }
    });
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe("/pair/123");
    expect(exchangeCode).toHaveBeenCalledWith(expect.objectContaining({
      code: "code-1",
      redirectUri: "https://connect.example/auth/github/callback"
    }));
    const sessionCookie = responseCookies(completed)
      .find((value) => value.startsWith("__Host-mdbase_session="))!;
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: cookiePair(sessionCookie) }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(expect.objectContaining({
      user: expect.objectContaining({
        name: "Callum",
        login: "callumalpass",
        email: null
      }),
      authentication: { provider: "github", registration: "closed" }
    }));

    const crossOriginLogout = await app.inject({
      method: "POST",
      url: "/v1/logout",
      headers: {
        cookie: cookiePair(sessionCookie),
        origin: "https://evil.example"
      }
    });
    expect(crossOriginLogout.statusCode).toBe(403);
    expect(crossOriginLogout.json().error.code).toBe("origin_denied");

    const sameOriginLogout = await app.inject({
      method: "POST",
      url: "/v1/logout",
      headers: {
        cookie: cookiePair(sessionCookie),
        origin: "https://connect.example"
      }
    });
    expect(sameOriginLogout.statusCode).toBe(200);

    const replay = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=code-2&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookiePair(oauthCookie) }
    });
    expect(replay.statusCode).toBe(400);
    expect(exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("rejects non-allowlisted identities before creating an account", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      publicUrl: "https://connect.example",
      githubAuth: {
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
        allowedUserIds: new Set(["12558714"]),
        exchangeCode: async () => ({
          id: "99999999",
          login: "someone-else",
          name: null,
          email: null,
          emailVerified: false
        })
      }
    });
    resources.push(() => app.close());

    const started = await app.inject({
      method: "GET",
      url: "/auth/github?return_to=https%3A%2F%2Fevil.example%2Fsteal"
    });
    const authorization = new URL(started.headers.location!);
    const state = authorization.searchParams.get("state")!;
    const oauthCookie = responseCookies(started)
      .find((value) => value.startsWith("__Host-mdbase_oauth_github="))!;
    const completed = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookiePair(oauthCookie) }
    });
    expect(completed.statusCode).toBe(403);
    expect(completed.json().error.code).toBe("account_not_allowed");
    const users = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
    expect(users.rows[0].count).toBe("0");
  });

  it("keeps hosted collection endpoints unavailable unless explicitly enabled", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({ db, devAuth: true });
    resources.push(() => app.close());
    const response = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      payload: { display_name: "Private" }
    });
    expect(response.statusCode).toBe(404);
    const login = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Local user", email: "local-only@example.com" }
    });
    const cookie = cookiePair(responseCookies(login)[0]);
    const dashboard = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie }
    });
    expect(dashboard.json().hosted_collections_available).toBe(false);
  });

  it("manages the complete hosted collection and receive-only mirror lifecycle", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedReferenceAuthority: true,
      publicUrl: "http://127.0.0.1:8787"
    });
    resources.push(() => app.close());
    const login = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Hosted user", email: "hosted@example.com" }
    });
    const cookie = cookiePair(responseCookies(login)[0]);
    const created = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      headers: { cookie },
      payload: { display_name: "Writing", timezone: "Australia/Melbourne" }
    });
    expect(created.statusCode).toBe(201);
    const collectionId = created.json().collection.id as string;
    const enrolled = await app.inject({
      method: "POST",
      url: `/v1/hosted/collections/${collectionId}/replicas`,
      headers: { cookie },
      payload: {
        name: "Laptop mirror",
        mode: "read_only",
        allowed_types: []
      }
    });
    expect(enrolled.statusCode).toBe(201);
    expect(enrolled.json().token).toMatch(/^hsr_/);
    const replicaId = enrolled.json().replica.id as string;
    const dashboard = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(dashboard.json().hosted_collections).toEqual([
      expect.objectContaining({
        id: collectionId,
        display_name: "Writing",
        template: "mdbase",
        contracts: [],
        replicas: [expect.objectContaining({ id: replicaId, mode: "read_only" })]
      })
    ]);
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/hosted/collections/${collectionId}`,
      headers: { cookie },
      payload: { display_name: "Renamed collection" }
    });
    expect(renamed.json().collection.display_name).toBe("Renamed collection");
    const rotated = await app.inject({
      method: "POST",
      url: `/v1/hosted/replicas/${replicaId}/token`,
      headers: { cookie }
    });
    expect(rotated.json().token).toMatch(/^hsr_/);
    expect(rotated.json().token).not.toBe(enrolled.json().token);

    // A folder paired in the browser before pairing was removed renews with
    // the secret of its consumed pairing row.
    const pairingId = randomUUID();
    await db.query(
      `INSERT INTO mirror_pairing_requests
         (id, secret_hash, mirror_name, mode, user_id, collection_id,
          replica_id, approved_at, consumed_at, expires_at)
       SELECT $1, $2, name, mode, authorized_user_id, collection_id, id, now(), now(), now()
       FROM hosted_replicas WHERE id = $3`,
      [pairingId, tokenHash("mirror-refresh-secret"), replicaId]
    );
    const renew = (headers: Record<string, string>) => app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/renew`,
      headers
    });
    const unauthenticated = await renew({});
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("invalid_mirror_pairing");
    const renewed = await renew({ authorization: "Bearer mirror-refresh-secret" });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json()).toMatchObject({
      status: "paired",
      replica: { id: replicaId, collection_id: collectionId },
      sync_url: `http://127.0.0.1:8787/v1/authorities/${collectionId}/sync`
    });
    expect(renewed.json().token).toMatch(/^hsr_/);
    expect(renewed.json().token).not.toBe(rotated.json().token);
    expect(Date.parse(renewed.json().token_expires_at)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1_000);
    expect((await db.query<{ token_hash: string }>(
      "SELECT token_hash FROM hosted_replicas WHERE id = $1", [replicaId]
    )).rows[0]?.token_hash).toBe(tokenHash(renewed.json().token));

    expect((await app.inject({
      method: "DELETE",
      url: `/v1/hosted/replicas/${replicaId}`,
      headers: { cookie }
    })).statusCode).toBe(200);
    const afterDisconnect = await renew({ authorization: "Bearer mirror-refresh-secret" });
    expect(afterDisconnect.statusCode).toBe(404);
    expect(afterDisconnect.json().error.code).toBe("mirror_pairing_not_found");
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/hosted/collections/${collectionId}`,
      headers: { cookie }
    })).statusCode).toBe(200);
    const empty = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(empty.json().hosted_collections).toEqual([]);
  });
});

function responseCookies(response: { headers: Record<string, string | string[] | undefined> }): string[] {
  const value = response.headers["set-cookie"];
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

function cookiePair(value: string): string {
  return value.split(";", 1)[0];
}
