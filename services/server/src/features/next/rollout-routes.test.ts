import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { registerNextRolloutRoutes } from "./rollout-routes.js";

describe("next local takeover rollout gate", () => {
  let db: DatabasePool;
  const app = Fastify();
  const owner = randomUUID();
  const connector = randomUUID();
  const token = randomUUID();
  const headers = { authorization: `Bearer ${token}` };
  beforeAll(async () => {
    db = await createDatabase("memory");
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')", [owner, `${owner}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Test',$3)", [connector, owner, tokenHash(token)]);
    registerNextRolloutRoutes(app, db);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it("refuses missing and invalid credentials", async () => {
    expect((await app.inject({ url: "/v1/next/rollout" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/next/rollout", headers: { authorization: "Bearer invalid" } })).statusCode).toBe(401);
  });
  it("returns only a closed, uncacheable gate for an active connector", async () => {
    const response = await app.inject({ url: "/v1/next/rollout", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ local_takeover: false });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("does not accept caller account IDs or switches to open takeover", async () => {
    const response = await app.inject({ url: `/v1/next/rollout?account=${randomUUID()}&local_takeover=true`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ local_takeover: false });
  });
  it("refuses a suspended account", async () => {
    await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [owner]);
    expect((await app.inject({ url: "/v1/next/rollout", headers })).statusCode).toBe(401);
    await db.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [owner]);
  });
  it("refuses a revoked connector", async () => {
    await db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [connector]);
    expect((await app.inject({ url: "/v1/next/rollout", headers })).statusCode).toBe(401);
  });
});
