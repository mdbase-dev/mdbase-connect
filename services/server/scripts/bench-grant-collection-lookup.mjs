// Run against a disposable localhost PostgreSQL test database, with the same
// MDBASE_CONNECT_TEST_DATABASE_URL and destructive-test approval as the PG suites:
// pnpm --filter @mdbase/connect-server exec tsx scripts/bench-grant-collection-lookup.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { createDatabase } from "../src/db.ts";
import { tokenHash } from "../src/security.ts";
import { localGrantFixture } from "../src/features/next/next-fixtures.test-helper.ts";
import { registerNextRouteRoutes } from "../src/features/next/route-routes.ts";
import { grantDeviceApproval } from "../src/features/next/grant-approval.ts";

const url = new URL(process.env.MDBASE_CONNECT_TEST_DATABASE_URL);
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && /test/i.test(url.pathname));
assert.equal(process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL, "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS");
const schema = "bench_grant_" + randomUUID().replaceAll("-", "");
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
// Isolate the join cost from PostgreSQL JIT compilation on expensive plans.
url.searchParams.set("options", `-csearch_path=${schema} -cjit=off`);
const app = Fastify();
let db;
try {
  db = await createDatabase(url.href);
  const grant = await localGrantFixture(db);
  const stranger = await localGrantFixture(db);
  const token = randomUUID();
  await db.query("UPDATE grants SET activated_at=now() WHERE id IN ($1,$2)", [grant, stranger]);
  await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$1,now()+interval '1 hour')", [grant, tokenHash(token)]);
  await db.query(`INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id,display_name)
    VALUES ($1,$1,'next','private',$2,'Benchmark')`, [grant, Buffer.alloc(32)]);

  // Use the production code for both arms, restoring only the previous join in A.
  let arm, explain, plan;
  const adapter = {
    async query(sql, values) {
      const join = /nc\.collection_id = COALESCE\(col\.local_id, (?:hc\.id|g\.hosted_collection_id), g\.next_collection_id\)/;
      if (join.test(sql)) {
        if (arm === "A") sql = sql.replace(join, match => match.replace(/\b(?:nc|col|hc|g)\.\w+/g, "$&::text"));
        if (explain) plan = (await db.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values)).rows[0]["QUERY PLAN"][0].Plan;
      }
      return db.query(sql, values);
    }
  };
  registerNextRouteRoutes(app, { db: adapter, publicUrl: "https://connect.example", broker: {
    request() { throw new Error("Unexpected relay request"); }
  } });
  const operations = {
    async switcher() {
      const res = await app.inject({ url: "/v1/next/apps/collections", headers: { authorization: "Bearer " + token } });
      assert.equal(res.statusCode, 200);
      return res.json().collections;
    },
    approval() { return grantDeviceApproval(adapter, grant); }
  };
  for (const unrelated of [0, 25000]) {
    await db.query(`INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id)
      SELECT gen_random_uuid(),$1,'next','private',$2 FROM generate_series(1,$3::integer)`, [stranger, Buffer.alloc(32), unrelated]);
    for (const table of ["next_collections", "grants", "collections", "users", "access_tokens", "hosted_collections", "next_grant_client_keys", "next_grant_bindings", "next_grant_approvals"]) await db.query(`ANALYZE ${table}`);
    for (const [name, run] of Object.entries(operations)) {
      const times = { A: [], B: [] };
      let expected;
      for (const variant of ["A", "B"]) {
        arm = variant;
        plan = undefined;
        explain = true;
        const result = await run();
        assert(plan, "Expected the production collection join");
        if (name === "switcher") assert.deepEqual(result.map(row => row.collection), [grant]);
        else assert.equal(result.required, true);
        if (variant === "A") expected = result;
        else assert.deepEqual(result, expected);
        const nodes = node => [node, ...(node.Plans ?? []).flatMap(nodes)];
        const scans = nodes(plan).filter(node => node["Relation Name"] === "next_collections");
        console.log(name, unrelated, variant, scans.map(node => [node["Node Type"], node["Index Name"], node["Actual Rows"]]));
      }
      explain = false;
      for (let i = 0; i < 46; i++) {
        for (const variant of i % 2 ? ["B", "A"] : ["A", "B"]) {
          arm = variant;
          const start = performance.now();
          const result = await run();
          const elapsed = performance.now() - start;
          assert.deepEqual(result, expected);
          if (i >= 6) times[variant].push(elapsed);
        }
      }
      for (const [variant, samples] of Object.entries(times)) {
        samples.sort((a, b) => a - b);
        const percentile = p => samples[Math.ceil(samples.length * p) - 1].toFixed(3);
        console.log(name, unrelated, variant, "p50/p95 ms", percentile(0.50), percentile(0.95));
      }
    }
  }
} finally {
  await app.close();
  await db?.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
