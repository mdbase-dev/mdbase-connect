import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTHORITY_PROOF_HEADERS, AUTHORITY_PROOF_VERSION } from "@mdbase-dev/connect-protocol";
import { authorityProofMessage } from "../../authority-proof.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { localGrantFixture } from "../next/next-fixtures.test-helper.js";
import { readAccountBackend, registerAccountBackendRoute } from "./backend-routes.js";
import type { DatabaseQueryable } from "../../database-types.js";

const url = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = url && approved ? describe : describe.skip;
const path = "/v1/account/backend";
const keys = () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  return { privateKey: pair.privateKey, publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url") };
};

describe("account backend discriminator", () => {
  it("accepts only the two literal persisted values, never coercion/defaults", async () => {
    // Reader unit model, separate from the real PostgreSQL cases below.
    const read = (value: unknown) => readAccountBackend({ query: vi.fn(async () => ({ rows: [{ account_backend: value }] })) } as unknown as DatabaseQueryable, "unit-account");
    expect(await read("legacy")).toBe("legacy");
    expect(await read("next")).toBe("next");
    for (const unknown of [undefined, null, "", "NEXT", "unknown", false, ["next"], { toString: () => "next" }]) await expect(read(unknown)).rejects.toThrow();
  });
});

describePg("grant-accessible account backend (dedicated PostgreSQL)", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const app = Fastify();
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || !/test/i.test(parsed.pathname)) throw new Error("Dedicated local test PostgreSQL required.");
    schema = `account_backend_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: parsed.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(parsed.toString());
    registerAccountBackendRoute(app, db);
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function fixture() {
    const grant = await localGrantFixture(db);
    const key = keys();
    const token = randomUUID();
    await db.query("UPDATE grants SET activated_at = now(), proof_public_key = $2 WHERE id = $1", [grant, key.publicKey]);
    await db.query("INSERT INTO access_tokens(id,grant_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [randomUUID(), grant, tokenHash(token)]);
    return { grant, token, key };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function headers(f: Fixture, input: { target?: string; credential?: string; method?: string; key?: ReturnType<typeof keys>; timestamp?: number } = {}) {
    const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
    const nonce = randomUUID();
    const signature = sign("sha256", Buffer.from(authorityProofMessage({
      method: input.method ?? "GET", target: input.target ?? path, body: "", credential: input.credential ?? f.token, timestamp, nonce
    })), { key: (input.key ?? f.key).privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return { authorization: `Bearer ${f.token}`, [AUTHORITY_PROOF_HEADERS.version]: String(AUTHORITY_PROOF_VERSION), [AUTHORITY_PROOF_HEADERS.timestamp]: String(timestamp), [AUTHORITY_PROOF_HEADERS.nonce]: nonce, [AUTHORITY_PROOF_HEADERS.signature]: signature };
  }
  const request = (f: Fixture, input?: Parameters<typeof headers>[1]) => app.inject({ method: "GET", url: path, headers: headers(f, input) });

  it("migration gives existing and new accounts legacy, and constrains the marker", async () => {
    const existing = await fixture();
    await db.query("ALTER TABLE users DROP COLUMN account_backend");
    await db.query(await readFile(new URL("../../../migrations/0049_account_backend.sql", import.meta.url), "utf8"));
    expect(await readAccountBackend(db, existing.grant)).toBe("legacy");
    const fresh = await fixture();
    expect(await readAccountBackend(db, fresh.grant)).toBe("legacy");
    await expect(db.query("UPDATE users SET account_backend = 'unknown' WHERE id = $1", [fresh.grant])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE users SET account_backend = NULL WHERE id = $1", [fresh.grant])).rejects.toMatchObject({ code: "23502" });
  });
  it("works before data describe/setup and returns only account ID and backend", async () => {
    const f = await fixture();
    const response = await request(f);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ account_id: f.grant, backend: "legacy" });
    expect((await db.query("SELECT operations FROM grants WHERE id = $1", [f.grant])).rows[0].operations).toEqual(["read"]);
  });
  it("reads the consenting account, not creator/connector account, and observes explicit changes", async () => {
    const f = await fixture();
    const account = randomUUID();
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Consenting account','next')", [account, `${account}@example.test`]);
    await db.query("UPDATE grants SET user_id = $2 WHERE id = $1", [f.grant, account]);
    expect((await request(f)).json()).toEqual({ account_id: account, backend: "next" });
    await db.query("UPDATE users SET account_backend = 'legacy' WHERE id = $1", [account]);
    expect((await request(f)).json()).toEqual({ account_id: account, backend: "legacy" });
  });
  it("requires a retained grant and its actual proof key, never a portal cookie alone", async () => {
    const f = await fixture();
    expect((await app.inject({ method: "GET", url: path, headers: { cookie: "session=irrelevant" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${f.token}` } })).statusCode).toBe(401);
    expect((await request(f, { key: keys() })).statusCode).toBe(401);
    await db.query("UPDATE grants SET proof_public_key = NULL WHERE id = $1", [f.grant]);
    expect((await request(f)).statusCode).toBe(401);
  });
  it("binds proof to the actual path, method, credential and time", async () => {
    const f = await fixture();
    for (const changed of [{ target: "/v1/account" }, { method: "POST" }, { credential: "different-token" }, { timestamp: Math.floor(Date.now()/1000) - 301 }]) {
      expect((await request(f, changed)).statusCode).toBe(401);
    }
  });
  it.each([
    "UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1",
    "UPDATE access_tokens SET expires_at = now() - interval '1 second' WHERE grant_id = $1",
    "UPDATE grants SET revoked_at = now() WHERE id = $1",
    "UPDATE grants SET activated_at = NULL WHERE id = $1",
    "UPDATE users SET suspended_at = now() WHERE id = $1"
  ])("denies an unusable token/grant/account: %s", async (sql) => {
    const f = await fixture(); await db.query(sql, [f.grant]);
    const response = await request(f);
    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty("backend");
  });
  it("reads revocation committed while acquiring the connection, without legacy fallback", async () => {
    const f = await fixture(); const original = db.connect.bind(db);
    const spy = vi.spyOn(db, "connect").mockImplementationOnce(async () => {
      await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [f.grant]);
      return original();
    });
    try { expect((await request(f)).statusCode).toBe(401); } finally { spy.mockRestore(); }
  });
  it("rejects a nil consenting account", async () => {
    const f = await fixture();
    const nil = "00000000-0000-0000-0000-000000000000";
    await db.query("INSERT INTO users(id,email,name) VALUES($1,'nil-backend@example.test','Nil test account') ON CONFLICT DO NOTHING", [nil]);
    await db.query("UPDATE grants SET user_id = $2 WHERE id = $1", [f.grant, nil]);
    expect((await request(f)).statusCode).toBe(401);
  });
  it("rejects token expiry during a lock wait", async () => {
    const f = await fixture();
    await db.query("UPDATE access_tokens SET expires_at = clock_timestamp() + interval '200 milliseconds' WHERE grant_id = $1", [f.grant]);
    const blocker = await db.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM grants WHERE id = $1 FOR UPDATE", [f.grant]);
    const release = setTimeout(() => { void blocker.query("COMMIT"); }, 400);
    try { expect((await request(f)).statusCode).toBe(401); }
    finally { clearTimeout(release); await blocker.query("ROLLBACK"); blocker.release(); }
  });
  it("bounds a conflicting grant lock and returns busy rather than any backend", async () => {
    const f = await fixture(); const blocker = await db.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM grants WHERE id = $1 FOR UPDATE", [f.grant]);
    try {
      const response = await request(f);
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("busy");
      expect(response.json()).not.toHaveProperty("backend");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  }, 10_000);
  it("has no app-accessible backend setter", async () => {
    const f = await fixture();
    expect((await app.inject({ method: "PUT", url: path, headers: headers(f), payload: { backend: "next" } })).statusCode).toBe(404);
    expect(await readAccountBackend(db, f.grant)).toBe("legacy");
  });
});
