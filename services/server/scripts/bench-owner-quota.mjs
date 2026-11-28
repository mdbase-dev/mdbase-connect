// Run pnpm --filter "@mdbase/connect-server..." build, then set PGHOST, PGPORT,
// PGUSER, PGPASSWORD and PGDATABASE pointing at a disposable PostgreSQL database:
// node services/server/scripts/bench-owner-quota.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { nativeCollectionQuotaUsage } from "../dist/features/next/policy-outbox.js";
import { nextFileBytes } from "../dist/features/next/storage-usage.js";

const migration = await readFile(new URL("../migrations/0112_next_collections_by_owner.sql", import.meta.url), "utf8");
const client = new pg.Client();
await client.connect();
try {
  await client.query("SET search_path TO pg_temp");
  await client.query("SET temp_buffers TO '128MB'");
  await client.query(`
    CREATE TEMP TABLE next_collections (
      collection_id uuid PRIMARY KEY, owner_user_id uuid NOT NULL,
      runtime text NOT NULL, sync text NOT NULL, left_sync_at timestamptz,
      UNIQUE (collection_id, sync)
    );
    CREATE TEMP TABLE next_collection_deletion_facts (collection_id uuid PRIMARY KEY);
    INSERT INTO next_collections
      SELECT md5(o || ':' || slot)::uuid, md5(o::text)::uuid,
        CASE WHEN slot = 5 THEN 'shadow' ELSE 'next' END,
        CASE WHEN slot % 2 = 0 THEN 'private' ELSE 'cloud_copy' END,
        CASE WHEN slot = 3 THEN now() END
      FROM generate_series(1, 20000) o CROSS JOIN generate_series(1, 5) slot;
    INSERT INTO next_collection_deletion_facts
      SELECT md5(o || ':4')::uuid FROM generate_series(1, 20000) o;
  `);
  await client.query("VACUUM ANALYZE next_collections");
  await client.query("VACUUM ANALYZE next_collection_deletion_facts");
  const owners = (await client.query("SELECT md5(o::text)::uuid AS id FROM generate_series(1, 10) o")).rows;
  const samples = [];
  // Capture the SQL execution time and buffer accesses for the actual query.
  // Run it normally as well so both plans must produce the expected result.
  let plan;
  const db = {
    async query(sql, args) {
      const explained = await client.query(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${sql}`, args);
      plan = explained.rows[0]["QUERY PLAN"][0];
      return client.query(sql, args);
    }
  };
  const log = { storageStatus: async () => ({ fileBytes: 1 }) };
  for (let pair = 0; pair < 6; pair++) {
    for (const variant of (pair % 2 ? ["index", "baseline"] : ["baseline", "index"])) {
      await client.query("DROP INDEX IF EXISTS pg_temp.next_collections_owner_collection_idx");
      if (variant === "index") await client.query(migration);
      for (const [i, owner] of owners.entries()) {
        for (const query of ["quota", "held"]) {
          if (query === "quota") assert.equal(await nativeCollectionQuotaUsage(db, owner.id), 2);
          else assert.equal(await nextFileBytes(db, log, owner.id), 3);
          // Use the first owner in each block to warm both queries.
          if (i === 0) continue;
          samples.push({
            variant, query, ms: plan["Execution Time"],
            blocks: plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"]
          });
        }
      }
    }
  }
  for (const query of ["quota", "held"]) {
    for (const variant of ["baseline", "index"]) {
      const rows = samples.filter(row => row.query === query && row.variant === variant);
      const percentile = (key, p) => rows.map(row => row[key]).sort((a, b) => a - b)[Math.ceil(p * rows.length) - 1];
      console.log({ query, variant, n: rows.length, medianMs: percentile("ms", 0.5),
        p95Ms: percentile("ms", 0.95), medianBlocks: percentile("blocks", 0.5) });
    }
  }
} finally {
  await client.end();
}
