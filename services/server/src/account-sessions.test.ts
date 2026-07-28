import { afterEach, describe, expect, it } from "vitest";
import {
  AccountSessionService,
  sessionClientName
} from "./account-sessions.js";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";

const resources: Array<() => Promise<void>> = [];
const origin = "http://127.0.0.1:8787";

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("account browser sessions", () => {
  it("lists active sessions, identifies the current browser, and revokes only owned sessions", async () => {
    const { app } = await fixture();
    const first = await login(
      app,
      "person@example.com",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/18.0 Safari/605.1.15"
    );
    const second = await login(
      app,
      "person@example.com",
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
    );
    const otherAccount = await login(
      app,
      "other@example.com",
      "Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0"
    );

    const listed = await app.inject({
      method: "GET",
      url: "/v1/account/sessions",
      headers: { cookie: second.cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.json().sessions).toHaveLength(2);
    expect(listed.json().sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        client_name: "Safari on macOS",
        current: false
      }),
      expect.objectContaining({
        client_name: "Chrome on Windows",
        current: true
      })
    ]));

    const otherListed = await app.inject({
      method: "GET",
      url: "/v1/account/sessions",
      headers: { cookie: otherAccount.cookie }
    });
    const otherSessionId = otherListed.json().sessions[0].id as string;
    const crossAccount = await app.inject({
      method: "DELETE",
      url: `/v1/account/sessions/${otherSessionId}`,
      headers: { cookie: second.cookie, origin }
    });
    expect(crossAccount.statusCode).toBe(404);

    const firstSessionId = listed.json().sessions.find(
      (session: { current: boolean }) => !session.current
    ).id as string;
    const crossOrigin = await app.inject({
      method: "DELETE",
      url: `/v1/account/sessions/${firstSessionId}`,
      headers: { cookie: second.cookie, origin: "https://evil.example" }
    });
    expect(crossOrigin.statusCode).toBe(403);
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/account/sessions/${firstSessionId}`,
      headers: { cookie: second.cookie, origin }
    });
    expect(revoked.statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: first.cookie }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: second.cookie }
    })).statusCode).toBe(200);
  });

  it("signs out every other browser while preserving the current session", async () => {
    const { app, db } = await fixture();
    const first = await login(app, "person@example.com", "Browser one");
    const current = await login(app, "person@example.com", "Browser two");
    const third = await login(app, "person@example.com", "Browser three");
    const response = await app.inject({
      method: "POST",
      url: "/v1/account/sessions/revoke-others",
      headers: { cookie: current.cookie, origin }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revoked_count).toBe(2);
    expect((await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: current.cookie }
    })).statusCode).toBe(200);
    for (const stale of [first, third]) {
      expect((await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { cookie: stale.cookie }
      })).statusCode).toBe(401);
    }
    const event = await db.query<{ metadata: { revoked_count: number } }>(
      `SELECT metadata FROM audit_events
       WHERE event_type = 'session.revoked_others'`
    );
    expect(event.rows[0]?.metadata).toEqual({ revoked_count: 2 });
  });

  it("updates last-seen time only after the coarse activity interval", async () => {
    const { app, db } = await fixture();
    const session = await login(app, "person@example.com", "Browser");
    await db.query(
      "UPDATE sessions SET last_seen_at = now() - interval '10 minutes'"
    );
    await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: session.cookie }
    });
    const touched = await db.query<{ last_seen_at: Date }>(
      "SELECT last_seen_at FROM sessions"
    );
    await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: session.cookie }
    });
    const unchanged = await db.query<{ last_seen_at: Date }>(
      "SELECT last_seen_at FROM sessions"
    );
    expect(unchanged.rows[0]?.last_seen_at).toEqual(
      touched.rows[0]?.last_seen_at
    );
  });

  it("uses a privacy-minimal, bounded browser label", () => {
    expect(sessionClientName(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile Safari/604.1"
    )).toBe("Safari on iPhone");
    expect(sessionClientName(
      "Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0"
    )).toBe("Firefox on Linux");
    expect(sessionClientName(undefined)).toBe("Browser session");
    expect(sessionClientName("unrecognized agent")).toBe("Browser");
  });

  it("keeps session operations reusable outside the HTTP boundary", async () => {
    const { db } = await fixture();
    const service = new AccountSessionService(db);
    await expect(service.list(
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000001"
    )).resolves.toEqual([]);
  });
});

async function fixture() {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const { app } = await buildApp({
    db,
    devAuth: true,
    publicUrl: origin
  });
  resources.push(() => app.close());
  return { app, db };
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  email: string,
  userAgent: string
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/dev/session",
    headers: { "user-agent": userAgent },
    payload: { name: "Person Example", email }
  });
  const sessionCookie = response.cookies.find(
    ({ name }) => name === "mdbase_session"
  )!;
  return {
    cookie: `${sessionCookie.name}=${sessionCookie.value}`
  };
}
