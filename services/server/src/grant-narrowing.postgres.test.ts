import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operationsForApplicationCapabilities } from "@mdbase-dev/connect-protocol";
import { registerAuthorizationRoutes } from "./features/authorizations/routes.js";
import type { AuthorizationRouteOptions } from "./features/authorizations/route-options.js";
import type { DatabasePool } from "./database-types.js";
import { buildPolicySnapshot } from "./relay-policy.js";

const url = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const suite = url && process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL
  === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS" ? describe : describe.skip;
const schema = `narrowing_test_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool;
let pool: pg.Pool;
function gate() { return Promise.withResolvers<void>(); }

suite("grant narrowing HTTP PostgreSQL serialization", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
      || !/test/i.test(parsed.pathname) || ["/postgres", "/template0", "/template1"].includes(parsed.pathname)) {
      throw new Error("A dedicated local test database is required");
    }
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 5, statement_timeout: 5000 });
    // Retained, precommitted policies, not fresh issuance or a gate override.
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY, email text UNIQUE, name text, suspended_at timestamptz);
      CREATE TABLE applications(id uuid PRIMARY KEY, requirements jsonb, notifications jsonb,
        provisions jsonb, family_identity text, manifest_digest text, application_declaration jsonb);
      ALTER TABLE applications ADD COLUMN name text DEFAULT 'Race fixture', ADD COLUMN distribution text DEFAULT 'portable',
        ADD COLUMN homepage text DEFAULT 'https://example.test', ADD COLUMN project_url text, ADD COLUMN icon text;
      CREATE TABLE connectors(id uuid PRIMARY KEY, user_id uuid, policy_sequence bigint DEFAULT 0,
        relay_generation bigint DEFAULT 1, revoked_at timestamptz);
      CREATE TABLE collections(id uuid PRIMARY KEY, connector_id uuid, local_id uuid, display_name text);
      CREATE TABLE hosted_replicas(id uuid PRIMARY KEY, allowed_types jsonb, revoked_at timestamptz, token_hash text);
      CREATE TABLE provider_revocation_jobs(id uuid, replica_id uuid, grant_id uuid, collection_id uuid, reason text);
      CREATE TABLE grants(id uuid PRIMARY KEY, user_id uuid, application_id uuid, collection_id uuid,
        hosted_replica_id uuid, hosted_collection_id uuid, operations jsonb, encryption jsonb, scope jsonb,
        file_capability jsonb, application_origin text, proof_public_key text, application_authorization jsonb,
        activated_at timestamptz, revoked_at timestamptz, notification_criteria jsonb DEFAULT '[]', created_at timestamptz DEFAULT now());
      CREATE TABLE access_tokens(grant_id uuid, revoked_at timestamptz);
      CREATE TABLE refresh_tokens(grant_id uuid, revoked_at timestamptz);
      CREATE TABLE audit_events(id uuid, user_id uuid, event_type text, subject_id uuid, metadata jsonb)`);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });

  it.each([1, 2] as const)("v%s stale contender cannot restore removed authority; rotations serialize", async (version) => {
    await race(version, "expansion");
    await race(version, "narrowing");
  });
  it("revocation holding the grant lock cannot be undone by PATCH", async () => {
    await race(2, "revocation");
    await race(2, "revoke_after_read");
  });

  it.each([1, 2] as const)("v%s hosted provider calls retain serialized narrowing", async (version) => {
    await race(version, "expansion", true);
    await race(version, "narrowing", true);
  });

  it("queues fail-closed hosted revocation after a provider change and failed commit", async () => {
    await race(2, "provider_commit_failure");
  });

  async function race(version: 1 | 2, scenario: "expansion" | "narrowing" | "revocation" | "revoke_after_read" | "provider_commit_failure", hostedRace = false) {
    const hosted = hostedRace || scenario === "provider_commit_failure";
    const id = randomUUID();
    const login = `${id}@example.test`;
    const capabilities = { contract_version: 2 as const,
      required: ["collection.read" as const], optional: ["records.create" as const, "records.delete" as const] };
    const read = version === 1 ? ["read"] : operationsForApplicationCapabilities({ ...capabilities, optional: [] });
    const initial = [...read, "create", "delete"];
    const aOps = [...read, "create"];
    const bOps = scenario === "expansion" ? [...read, "delete"] : read;
    await pool.query("INSERT INTO users VALUES($1,$2,'Race fixture',NULL)", [id, login]);
    await pool.query(`INSERT INTO applications(id,requirements,notifications,provisions,family_identity,manifest_digest,application_declaration)
      VALUES($1,$2,'{"criteria":[]}','{"type_packs":[]}',
      'bundle:dev.mdbase.race',$3,NULL)`, [id, JSON.stringify({ access: "full_collection", contracts: [],
      capabilities: version === 2 ? capabilities : { contract_version: 1, required: ["records.read", "records.create", "records.delete"] } }), "a".repeat(64)]);
    await pool.query("UPDATE applications SET application_declaration = jsonb_build_object('requirements',requirements) WHERE id=$1", [id]);
    await pool.query("INSERT INTO connectors(id,user_id) VALUES($1,$1)", [id]);
    await pool.query("INSERT INTO collections VALUES($1,$1,$1,'Race collection')", [id]);
    await pool.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,encryption,scope,activated_at)
      VALUES($1,$1,$1,$1,$2,'{"key_id":"enc_fixture","scope_epoch":1}','{"access":"full_collection","contracts":[]}',now())`, [id, JSON.stringify(initial)]);
    await pool.query(`UPDATE grants SET application_origin='https://example.test',
      application_authorization=$2 WHERE id=$1`, [id, JSON.stringify({ binding: { contracts: { semantic_capabilities: version } } })]);
    if (hosted) {
      await pool.query("INSERT INTO hosted_replicas(id,allowed_types) VALUES($1,'[]')", [id]);
      await pool.query("UPDATE grants SET hosted_replica_id=$1,hosted_collection_id=$1,collection_id=NULL WHERE id=$1", [id]);
    }
    const firstRead = gate(), releaseA = gate(), secondIssued = gate(), secondRead = gate(), releaseB = gate();
    if (scenario === "provider_commit_failure") releaseA.resolve();
    const providerPolicies: string[][] = [];
    let providerOperations: string[] | undefined;
    let failedCommit = false;
    let reads = 0;
    let contenderPid = 0;
    const wrapQuery = (client: pg.Pool | pg.PoolClient) => async (text: string, values?: unknown[]) => {
      if (scenario === "provider_commit_failure" && text === "COMMIT" && providerOperations && !failedCommit) {
        failedCommit = true;
        throw new Error("Injected commit failure after provider narrowing");
      }
      const policyRead = text.includes("SELECT g.id, g.operations") && values?.[0] === id;
      const ordinal = policyRead ? ++reads : 0;
      if (ordinal === 2) secondIssued.resolve();
      const result = await client.query(text, values);
      if (ordinal === 1) { firstRead.resolve(); await releaseA.promise; }
      if (ordinal === 2) { secondRead.resolve(); await releaseB.promise; }
      return result;
    };
    const db = { query: async (text: string, values?: unknown[]) => {
      if (text.startsWith("SELECT encryption") || text.startsWith("UPDATE grants SET encryption")) {
        throw new Error("Encryption rotation must not check out a second pool connection");
      }
      if (scenario === "revoke_after_read" && text.startsWith("UPDATE grants SET revoked_at")) {
        const client = await pool.connect();
        try {
          contenderPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          secondIssued.resolve();
          return await client.query(text, values);
        } finally { client.release(); }
      }
      return wrapQuery(pool)(text, values);
    }, end: async () => {}, connect: async () => {
      const client = await pool.connect();
      contenderPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return { query: wrapQuery(client), release: () => client.release() };
    } } as DatabasePool;
    const published: string[][] = [];
    const sequences: number[] = [];
    const app = Fastify();
    registerAuthorizationRoutes(app, { db, publicUrl: "http://localhost", tailscaleAuth: true,
      hostedProvider: hosted ? { updateApplicationReplica: async (_id: string, policy: { allowedOperations: string[] }) => {
        providerOperations = policy.allowedOperations;
        providerPolicies.push(policy.allowedOperations);
      } } as unknown as AuthorizationRouteOptions["hostedProvider"] : undefined,
      relay: { pushPolicy: async () => {
        const snapshot = await buildPolicySnapshot(pool, id, 60_000, '1', () => true, 'lease_v1', true);
        if (!snapshot || !("sequence" in snapshot)) throw new Error("Missing leased snapshot");
        sequences.push(snapshot.sequence);
        published.push(...snapshot.grants.map((grant) => grant.operations as string[]));
      } } as unknown as AuthorizationRouteOptions["relay"], drainProviderRevocations: async () => {} });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const patch = (operations: string[]) => fetch(`${base}/v1/grants/${id}`, { method: "PATCH",
      headers: { "content-type": "application/json", "tailscale-user-login": login }, body: JSON.stringify({ operations }) });
    let a: Promise<Response> | undefined, b: Promise<Response> | undefined;
    let revoke: pg.PoolClient | undefined;
    try {
      if (scenario === "provider_commit_failure") {
        a = patch(aOps);
        expect((await a).status).toBe(500);
        expect(providerOperations).toEqual(aOps);
        expect((await pool.query("SELECT reason FROM provider_revocation_jobs WHERE grant_id=$1", [id])).rows)
          .toEqual([{ reason: "narrowing_failed" }]);
        expect((await pool.query("SELECT revoked_at FROM grants WHERE id=$1", [id])).rows[0].revoked_at).not.toBeNull();
        expect((await pool.query("SELECT encryption FROM grants WHERE id=$1", [id])).rows[0].encryption.scope_epoch).toBe(1);
        expect(pool.waitingCount).toBe(0);
        return;
      }
      if (scenario === "revocation") {
        revoke = await pool.connect();
        await revoke.query("BEGIN");
        await revoke.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [id]);
        b = patch(bOps);
        await waitUntil(async () => contenderPid !== 0 && (await admin.query(
          "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [contenderPid])).rows[0].blocked);
        await revoke.query("COMMIT");
        // An empty active-grant result also passes through the instrumented read.
        releaseA.resolve(); releaseB.resolve();
        expect((await b).status).toBe(404);
      } else {
        a = patch(aOps);
        await firstRead.promise;
        b = scenario === "revoke_after_read"
          ? fetch(`${base}/v1/grants/${id}`, { method: "DELETE", headers: { "tailscale-user-login": login } })
          : patch(bOps);
        await secondIssued.promise;
        let returned = false;
        void secondRead.promise.then(() => { returned = true; });
        await waitUntil(async () => returned || (await admin.query(
          "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [contenderPid])).rows[0].blocked);
        releaseA.resolve();
        expect((await a).status).toBe(200);
        releaseB.resolve();
        const response = await b;
        expect(response.status).toBe(scenario === "expansion" ? 409 : 200);
        if (scenario === "expansion") expect(await response.json()).toMatchObject({ error: { code: "permission_expansion_requires_approval" } });
      }
      const final = (await pool.query("SELECT operations,encryption,revoked_at FROM grants WHERE id=$1", [id])).rows[0];
      expect(final.operations).toEqual(scenario === "revocation" ? initial : scenario === "expansion" || scenario === "revoke_after_read" ? aOps : bOps);
      expect(final.encryption.scope_epoch).toBe(scenario === "revocation" ? 1 : scenario === "expansion" || scenario === "revoke_after_read" ? 2 : 3);
      if (scenario === "revocation" || scenario === "revoke_after_read") expect(final.revoked_at).not.toBeNull();
      expect(published.every((operations) => !operations.includes("delete"))).toBe(true);
      expect(providerPolicies.every((operations) => !operations.includes("delete"))).toBe(true);
      if (hostedRace) expect(providerPolicies).toEqual(scenario === "expansion" ? [aOps] : [aOps, bOps]);
      expect(sequences).toEqual(scenario === "revocation" || hostedRace ? [] : scenario === "expansion" ? [1] : [1, 2]);
      expect(pool.waitingCount).toBe(0);
    } finally {
      releaseA.resolve(); releaseB.resolve();
      if (revoke) { await revoke.query("ROLLBACK"); revoke.release(); }
      await Promise.allSettled([a, b]);
      await app.close();
    }
  }
});

async function waitUntil(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    // Poll observed PostgreSQL lock state, not a scheduling sleep/barrier.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Expected contender to return its read or block on the grant lock");
}
