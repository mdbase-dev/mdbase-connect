// Build @mdbase-dev/connect-protocol first. Use the disposable PostgreSQL URL
// and destructive-test approval from the server PostgreSQL suites.
// pnpm --filter @mdbase/connect-server exec tsx scripts/bench-native-catalog.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDatabase } from "../src/db.ts";
import { listNativeCollectionsVisibleToUser } from "../src/features/collections/collection-catalog.ts";
import { createHostedCollectionMembership } from "../src/features/collections/collection-policy.ts";

const url = new URL(process.env.MDBASE_CONNECT_TEST_DATABASE_URL);
assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && /test/i.test(url.pathname));
assert.equal(process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL, "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS");
const schema = "bench_catalog_" + randomUUID().replaceAll("-", "");
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
await admin.query(`CREATE SCHEMA "${schema}"`);
let db;
try {
  url.searchParams.set("options", `-csearch_path=${schema}`);
  db = await createDatabase(url.href);
  const account = randomUUID(), other = randomUUID(), owned = randomUUID(), shared = randomUUID();
  await db.query(`INSERT INTO users(id,email,name)
    SELECT id,id::text || '@example.test','Catalog' FROM unnest($1::uuid[]) id`, [[account, other]]);
  await db.query(`INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id)
    VALUES ($1,$2,'next','private',$5),($3,$4,'next','cloud_copy',$5)`, [owned, account, shared, other, Buffer.alloc(32)]);
  await createHostedCollectionMembership(db, { collectionId: shared, ownerUserId: other, userId: account, role: "viewer" });

  for (const unrelated of [0, 25000]) {
    if (unrelated) {
      await db.query(`INSERT INTO users(id,email,name) SELECT md5(i::text)::uuid,i || '@example.test','Unrelated'
        FROM generate_series(1,1000) i`);
      await db.query(`INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id)
        SELECT gen_random_uuid(),md5((1 + i % 1000)::text)::uuid,'next','private',$1 FROM generate_series(1,$2::int) i`, [Buffer.alloc(32), unrelated]);
    }
    for (const table of ["users", "next_collections", "collection_identities", "collection_memberships",
      "collection_membership_policies", "next_collection_deletion_facts"]) await db.query(`ANALYZE ${table}`);

    const samples = { before: [], after: [] };
    const scans = {};
    let expected;
    for (let i = 0; i < 36; i++) {
      for (const variant of i % 2 ? ["after", "before"] : ["before", "after"]) {
        const rows = await listNativeCollectionsVisibleToUser({ async query(sql, params) {
          // Restore the prior query by removing only the candidate join.
          const baseline = sql.replace(/     JOIN \(\s+SELECT collection_id FROM next_collections[\s\S]+?candidate\.collection_id = native\.collection_id\n/, "");
          assert.notEqual(sql, baseline);
          const query = variant === "before" ? baseline : sql;
          const result = await db.query("EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) " + query, params);
          const plan = result.rows[0]["QUERY PLAN"][0];
          if (i >= 6) samples[variant].push({ ms: plan["Execution Time"], blocks: plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"] });
          const nodes = node => [node, ...(node.Plans ?? []).flatMap(nodes)];
          scans[variant] = nodes(plan.Plan).filter(n => n["Relation Name"] === "next_collections")
            .map(n => [n["Node Type"], n["Index Name"], n["Actual Rows"], n["Actual Loops"]]);
          return db.query(query, params);
        } }, account);
        assert.deepEqual(rows.map(r => [r.id, r.access.role]).sort(), [[owned, "owner"], [shared, "viewer"]].sort());
        expected ??= rows;
        assert.deepEqual(rows, expected);
      }
    }
    for (const [variant, rows] of Object.entries(samples)) {
      const percentile = (key, p) => rows.map(r => r[key]).sort((a,b) => a-b)[Math.ceil(rows.length * p) - 1];
      console.log({ unrelated, variant, n: rows.length, medianMs: percentile("ms", .5), p95Ms: percentile("ms", .95),
        medianBlocks: percentile("blocks", .5), scans: scans[variant] });
    }
  }
} finally {
  await db?.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
}
