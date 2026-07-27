import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";

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
      email: null
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
          email: null
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
      payload: { display_name: "Writing" }
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
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/hosted/replicas/${replicaId}`,
      headers: { cookie }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/hosted/collections/${collectionId}`,
      headers: { cookie }
    })).statusCode).toBe(200);
    const empty = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(empty.json().hosted_collections).toEqual([]);
  });

  it("pairs a folder through browser approval and renews device-local access", async () => {
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

    const started = await app.inject({
      method: "POST",
      url: "/v1/mirror-pairing-requests",
      payload: { mirror_name: "Writing laptop", mode: "read_write" }
    });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({
      pairing_secret: expect.stringMatching(/^mir_/),
      verification_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:8787\/mirror\//),
      expires_in: 600
    });
    const pairingId = started.json().pairing_id as string;
    const pairingSecret = started.json().pairing_secret as string;
    const pending = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/exchange`,
      headers: { authorization: `Bearer ${pairingSecret}` }
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toEqual({ status: "pending" });

    const login = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Mirror user", email: "mirror@example.com" }
    });
    const cookie = cookiePair(responseCookies(login)[0]);
    const firstCollection = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      headers: { cookie },
      payload: { display_name: "First collection" }
    });
    const secondCollection = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      headers: { cookie },
      payload: { display_name: "Second collection" }
    });
    const collectionId = secondCollection.json().collection.id as string;
    const approval = await app.inject({
      method: "GET",
      url: `/v1/mirror-pairing-requests/${pairingId}`,
      headers: { cookie }
    });
    expect(approval.json()).toMatchObject({
      pairing: { mirror_name: "Writing laptop", mode: "read_write", approved_at: null },
      collections: [
        { id: firstCollection.json().collection.id, display_name: "First collection" },
        { id: collectionId, display_name: "Second collection" }
      ]
    });
    expect((await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/approve`,
      headers: { cookie },
      payload: { collection_id: collectionId }
    })).statusCode).toBe(200);

    const exchanged = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/exchange`,
      headers: { authorization: `Bearer ${pairingSecret}` }
    });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json()).toMatchObject({
      status: "paired",
      replica: {
        collection_id: collectionId,
        name: "Writing laptop",
        mode: "read_write"
      },
      token: expect.stringMatching(/^hsr_/),
      token_expires_at: expect.any(String),
      sync_url: "http://127.0.0.1:8787"
    });
    const replicaId = exchanged.json().replica.id as string;
    const firstToken = exchanged.json().token as string;
    expect((await app.inject({
      method: "POST",
      url: `/v1/hosted/collections/${collectionId}/sync/sessions`,
      headers: { authorization: `Bearer ${firstToken}` }
    })).statusCode).toBe(200);

    const replayed = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/exchange`,
      headers: { authorization: `Bearer ${pairingSecret}` }
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().replica.id).toBe(replicaId);
    expect(replayed.json().token).not.toBe(firstToken);
    expect((await app.inject({
      method: "POST",
      url: `/v1/hosted/collections/${collectionId}/sync/sessions`,
      headers: { authorization: `Bearer ${firstToken}` }
    })).statusCode).toBe(401);

    const pairingRow = await db.query(
      "SELECT id, consumed_at, replica_id, collection_id FROM mirror_pairing_requests WHERE id = $1",
      [pairingId]
    );
    expect(pairingRow.rows[0]).toMatchObject({
      id: pairingId,
      consumed_at: expect.anything(),
      replica_id: replicaId,
      collection_id: collectionId
    });
    const renewed = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/renew`,
      headers: { authorization: `Bearer ${pairingSecret}` }
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().replica.id).toBe(replicaId);
    expect(renewed.json().token).not.toBe(replayed.json().token);

    const dashboard = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(dashboard.json().hosted_collections[1].replicas).toEqual([
      expect.objectContaining({ id: replicaId, name: "Writing laptop", mode: "read_write" })
    ]);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/hosted/replicas/${replicaId}`,
      headers: { cookie }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/renew`,
      headers: { authorization: `Bearer ${pairingSecret}` }
    })).statusCode).toBe(404);
  });
});

function responseCookies(response: { headers: Record<string, string | string[] | undefined> }): string[] {
  const value = response.headers["set-cookie"];
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

function cookiePair(value: string): string {
  return value.split(";", 1)[0];
}
