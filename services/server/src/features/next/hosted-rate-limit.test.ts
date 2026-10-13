import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { globalRateLimitKeying } from "./hosted-routes.js";

const PUBLIC_REQUESTS_PER_MINUTE = 600;
const SERVICE_REQUESTS_PER_MINUTE = 12_000;

const tokens = { hosted: "h".repeat(32), escrow: "e".repeat(32) };
const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

async function build() {
  const app = Fastify();
  apps.push(app);
  await app.register(rateLimit, { global: true, ...globalRateLimitKeying(tokens), timeWindow: "1 minute" });
  app.get("/internal/v1/next/collections/:id/service-devices/:kind", async () => ({ ok: true }));
  app.get("/internal/v1/limited", { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } }, async () => ({ ok: true }));
  app.get("/v1/public", async () => ({ ok: true }));
  return app;
}

const internal = (app: Awaited<ReturnType<typeof build>>, token?: string) => app.inject({
  method: "GET", url: "/internal/v1/next/collections/c/service-devices/hosted",
  headers: token ? { authorization: `Bearer ${token}` } : {}
});

describe("global rate limit keying", () => {
  it("counts authenticated internal calls per service, not against the caller's IP", async () => {
    const app = await build();
    for (let i = 0; i < PUBLIC_REQUESTS_PER_MINUTE + 5; i++) expect((await internal(app, tokens.hosted)).statusCode).toBe(200);
    const last = await internal(app, tokens.hosted);
    expect(Number(last.headers["x-ratelimit-limit"])).toBe(SERVICE_REQUESTS_PER_MINUTE);
    // The same IP's public budget is untouched.
    const pub = await app.inject({ method: "GET", url: "/v1/public" });
    expect(pub.statusCode).toBe(200);
    expect(Number(pub.headers["x-ratelimit-remaining"])).toBe(PUBLIC_REQUESTS_PER_MINUTE - 1);
  });

  it("keeps unauthenticated, wrong-token and own-limit internal calls on the per-IP limits", async () => {
    const app = await build();
    for (let i = 0; i < PUBLIC_REQUESTS_PER_MINUTE / 2; i++) expect((await internal(app)).statusCode).toBe(200);
    for (let i = 0; i < PUBLIC_REQUESTS_PER_MINUTE / 2; i++) expect((await internal(app, "x".repeat(32))).statusCode).toBe(200);
    expect((await internal(app, "x".repeat(32))).statusCode).toBe(429);
    expect((await app.inject({ method: "GET", url: "/v1/public" })).statusCode).toBe(429);
    // A route with its own limit is not lifted by a valid service token.
    const limited = () => app.inject({ method: "GET", url: "/internal/v1/limited", headers: { authorization: `Bearer ${tokens.hosted}` } });
    expect((await limited()).statusCode).toBe(200);
    expect((await limited()).statusCode).toBe(200);
    expect((await limited()).statusCode).toBe(429);
  });
});
