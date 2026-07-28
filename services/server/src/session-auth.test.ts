import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("account session enforcement", () => {
  it("rejects revoked, stale-epoch, and suspended sessions", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://127.0.0.1:8787"
    });
    resources.push(() => app.close());
    const login = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Beta User", email: "beta@example.com" }
    });
    const userId = login.json().user.id as string;
    const cookie = login.cookies[0]?.name && login.cookies[0]?.value
      ? `${login.cookies[0].name}=${login.cookies[0].value}`
      : "";
    expect(cookie).not.toBe("");
    await expectMe(app, cookie, 200);

    await db.query(
      "UPDATE sessions SET revoked_at = now() WHERE user_id = $1",
      [userId]
    );
    await expectMe(app, cookie, 401);

    const secondLogin = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Beta User", email: "beta@example.com" }
    });
    const secondCookie = `${secondLogin.cookies[0]?.name}=${secondLogin.cookies[0]?.value}`;
    await expectMe(app, secondCookie, 200);
    await db.query(
      "UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1",
      [userId]
    );
    await expectMe(app, secondCookie, 401);

    const thirdLogin = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Beta User", email: "beta@example.com" }
    });
    const thirdCookie = `${thirdLogin.cookies[0]?.name}=${thirdLogin.cookies[0]?.value}`;
    await expectMe(app, thirdCookie, 200);
    await db.query(
      "UPDATE users SET suspended_at = now() WHERE id = $1",
      [userId]
    );
    await expectMe(app, thirdCookie, 401);
  });

  it("applies account suspension to Tailscale-authenticated requests", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      tailscaleAuth: true,
      publicUrl: "https://connect.example"
    });
    resources.push(() => app.close());
    const headers = {
      "tailscale-user-login": "beta@example.com",
      "tailscale-user-name": "Beta User"
    };
    const active = await app.inject({ method: "GET", url: "/v1/me", headers });
    expect(active.statusCode).toBe(200);
    await db.query(
      "UPDATE users SET suspended_at = now() WHERE email = 'beta@example.com'"
    );
    const suspended = await app.inject({ method: "GET", url: "/v1/me", headers });
    expect(suspended.statusCode).toBe(401);
  });
});

async function expectMe(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  cookie: string,
  statusCode: number
): Promise<void> {
  const response = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { cookie }
  });
  expect(response.statusCode).toBe(statusCode);
}
