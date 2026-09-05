import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APPLICATION_DECLARATION_EVIDENCE_CAPABILITY, CONNECT_CONTRACT_SUPPORT,
  authorizationContractRequirements } from "@mdbase-dev/connect-protocol";
import { RelayHub } from "./relay.js";

const url = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL
  === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = url && approved ? describe : describe.skip;
const v2 = authorizationContractRequirements(["read"]);
let admin: pg.Pool;
let pool: pg.Pool;
let contender: pg.Pool;
const schema = `relay_publication_test_${randomUUID().replaceAll("-", "")}`;

function authority(db: pg.Pool, id: string) {
  const hub = Object.create(RelayHub.prototype) as RelayHub;
  const session = { ready: true, generation: "1", socket: { readyState: 1 },
    capabilities: [APPLICATION_DECLARATION_EVIDENCE_CAPABILITY],
    contractSupport: structuredClone(CONNECT_CONTRACT_SUPPORT) };
  Object.assign(hub, { db, closed: false, connectors: new Map([[id, session]]) });
  return { hub, session };
}

async function waitForBlock(blocked: number, holder: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await admin.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [holder, blocked]);
    if (result.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected the contender to block on the publication transaction's row lock.");
}

suite("authorization publication PostgreSQL transaction fence", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
        || !/test/i.test(parsed.pathname)
        || ["/postgres", "/template0", "/template1"].includes(parsed.pathname)) {
      throw new Error("A dedicated local test database is required.");
    }
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    const config = { connectionString: parsed.toString(), max: 1,
      connectionTimeoutMillis: 500, statement_timeout: 5_000 };
    pool = new pg.Pool(config);
    contender = new pg.Pool(config);
    await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY, suspended_at timestamptz);
      CREATE TABLE connectors (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id),
        relay_generation bigint NOT NULL, revoked_at timestamptz);
      CREATE TABLE publications (connector_id uuid, generation bigint)`);
  });
  afterAll(async () => {
    await Promise.all([pool?.end(), contender?.end()]);
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("rolls back publication if the live session disconnects while replacement waits", async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO users(id) VALUES($1)", [id]);
    await pool.query("INSERT INTO connectors VALUES($1,$1,1,NULL)", [id]);
    const { hub, session } = authority(pool, id);
    const tx = await pool.connect();
    const next = await contender.connect();
    let replacement: Promise<pg.QueryResult> | undefined;
    try {
      const holder = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const blocked = (await next.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await tx.query("BEGIN");
      await hub.assertAuthorizationAuthority(id, "1", v2, tx);
      await tx.query("INSERT INTO publications VALUES($1,1)", [id]);
      replacement = next.query("UPDATE connectors SET relay_generation=2 WHERE id=$1", [id]);
      await waitForBlock(blocked, holder);
      session.socket.readyState = 3;
      expect(() => hub.authorizationAuthority(id, v2)).toThrow();
      await tx.query("ROLLBACK");
      await replacement;
      expect((await tx.query("SELECT * FROM publications WHERE connector_id=$1", [id])).rows).toEqual([]);
    } finally {
      await tx.query("ROLLBACK");
      await replacement?.catch(() => undefined);
      tx.release();
      next.release();
    }
  });

  it.each(["replacement", "suspension"])("pool-size-one assertion holds %s behind commit without a nested checkout", async (change) => {
    const id = randomUUID();
    await pool.query("INSERT INTO users(id) VALUES($1)", [id]);
    await pool.query("INSERT INTO connectors VALUES($1,$1,1,NULL)", [id]);
    const { hub, session } = authority(pool, id);
    const tx = await pool.connect();
    const next = await contender.connect();
    const holder = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const blocked = (await next.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    // Holding the sole pool slot makes any pool.query inside assertion a real
    // nested-checkout bug; the spy also pinpoints it instead of merely timing out.
    const nestedCheckout = vi.spyOn(pool, "query").mockImplementation(() => {
      throw new Error("Nested checkout while finalization owns the sole pool slot");
    });
    let replacement: Promise<pg.QueryResult> | undefined;
    let committed = false;
    try {
      await tx.query("BEGIN");
      await hub.assertAuthorizationAuthority(id, "1", v2, tx);
      await tx.query("INSERT INTO publications VALUES($1,1)", [id]);
      let settled = false;
      replacement = next.query(change === "replacement"
        ? "UPDATE connectors SET relay_generation=2 WHERE id=$1 RETURNING relay_generation"
        : "UPDATE users SET suspended_at=now() WHERE id=$1 RETURNING id", [id]);
      void replacement.then(() => { settled = true; }, () => { settled = true; });
      await waitForBlock(blocked, holder);
      expect(settled).toBe(false);
      expect(hub.authorizationAuthority(id, v2)).toBe("1");
      await tx.query("COMMIT");
      committed = true;
      await replacement;
      expect(nestedCheckout).not.toHaveBeenCalled();
      expect((await tx.query("SELECT generation FROM publications WHERE connector_id=$1", [id])).rows)
        .toEqual([{ generation: "1" }]);
      // This is a postcommit transition, not permission to send v2 to gen B.
      if (change === "replacement") {
        session.generation = "2";
        session.contractSupport.semantic_capabilities = [1];
        expect(hub.supportsContracts(id, v2)).toBe(false);
      }
      await tx.query("BEGIN");
      try {
        await expect(hub.assertAuthorizationAuthority(id, "1", v2, tx)).rejects.toThrow();
      } finally {
        await tx.query("ROLLBACK");
      }
    } finally {
      nestedCheckout.mockRestore();
      if (!committed) await tx.query("ROLLBACK");
      await replacement?.catch(() => undefined);
      tx.release();
      next.release();
    }
  });
});
