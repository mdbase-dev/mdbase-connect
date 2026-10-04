import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { parseNextControlPlaneEnv } from "./policy-keys.js";
import { registerNextHostedRoutes } from "./hosted-routes.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

const hosted = "h".repeat(40);
const escrow = "e".repeat(40);

describe("service tokens configuration", () => {
  const base = {
    MDBASE_NEXT_CONTROL_PLANE: "1",
    MDBASE_NEXT_ROOT_PUBLIC_KEY: "00".repeat(32),
    MDBASE_NEXT_POLICY_SIGNING_KEY: "pem",
    MDBASE_NEXT_POLICY_KEY_CERT: "{}",
    MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example",
    MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "pem",
    MDBASE_NEXT_LOG_TRANSPORT_KEY: "pem"
  };
  it("is optional, must be long, and differs per kind", () => {
    expect(parseNextControlPlaneEnv(base)?.serviceTokens).toEqual({});
    expect(parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: hosted, MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: escrow })?.serviceTokens).toEqual({ hosted, escrow });
    expect(() => parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: "short" })).toThrow(/32 characters/);
    expect(() => parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: hosted, MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: hosted })).toThrow(/must differ/);
  });
});

describePostgres("hosted replica directory", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const app = Fastify();
  const ids = { owner: randomUUID(), standard: randomUUID(), private: randomUUID(), local: randomUUID(), retired: randomUUID(), unknown: randomUUID(), left: randomUUID() };

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Directory tests require a dedicated local test database.");
    schema = `mdbase_next_directory_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')", [ids.owner, `${ids.owner}@example.test`]);
    for (const [id, sync] of [[ids.standard, "cloud_copy"], [ids.private, "private"], [ids.left, "cloud_copy"]]) {
      await db.query("INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id) VALUES($1,$2,'next',$3,$4)", [id, ids.owner, sync, Buffer.alloc(16)]);
    }
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Daemon',$3)", [ids.owner, ids.owner, ids.owner]);
    for (const [id, state] of [[ids.local, "active"], [ids.retired, "retired"]]) {
      await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,authority_state)
        VALUES($1,$2,$2,$3,'Local','0.3.0',$4)`, [randomUUID(), ids.owner, id, state]);
    }
    await db.query("UPDATE next_collections SET left_sync_at = now() WHERE collection_id = $1", [ids.left]);
    await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version)
      VALUES($1,$2,$2,$3,'Was synced','0.3.0')`, [randomUUID(), ids.owner, ids.left]);
    registerNextHostedRoutes(app, { db, tokens: { hosted, escrow } });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  it("reports standard only for cloud-copy collections", async () => {
    const response = await app.inject({
      method: "POST", url: "/internal/v1/next/collections/states",
      headers: { authorization: `Bearer ${hosted}` },
      payload: { ids: [ids.standard, ids.private, ids.local, ids.retired, ids.unknown, ids.left] }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().collections.map((entry: { state: string }) => entry.state)).toEqual(["standard", "private", "local", "unknown", "unknown", "unknown"]);
    const single = await app.inject({ method: "GET", url: `/internal/v1/next/collections/${ids.standard}/state`, headers: { authorization: `Bearer ${escrow}` } });
    expect(single.json()).toEqual({ collection: ids.standard, state: "standard", runtime: "next" });
  });

  it("refuses requests without a service token", async () => {
    for (const authorization of [undefined, "Bearer wrong-token-of-sufficient-length-xxxxxxx"]) {
      const response = await app.inject({ method: "GET", url: `/internal/v1/next/collections/${ids.standard}/state`, headers: authorization ? { authorization } : {} });
      expect(response.statusCode).toBe(401);
    }
  });
});
