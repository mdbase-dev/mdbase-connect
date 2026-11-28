// Measure SQLite cursor work on a byte-limited 64-item page in workerd.
// Called by pull-pages.mjs with the adapter queries from the two revisions.
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

export async function checkWorkerdRows(queries) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "pull-page-bench", modules: true, compatibilityDate: "2026-10-04",
    durableObjects: { LOG: { className: "Probe", useSQLite: true } },
    script: `
      const queries = ${JSON.stringify(queries)};
      export class Probe {
        constructor(ctx) {
          this.sql = ctx.storage.sql;
          this.sql.exec("CREATE TABLE items(seq INTEGER PRIMARY KEY, kind INTEGER NOT NULL, bytes BLOB NOT NULL, appended_at INTEGER NOT NULL)");
          this.sql.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000) INSERT INTO items SELECT i,1,zeroblob(16384),i FROM n");
        }
        fetch(req) {
          const before = new URL(req.url).pathname === "/before";
          const args = before ? [0,1000,1<<20] : [1<<20,0,1000];
          const cursor = this.sql.exec(queries[before ? "before" : "after"], ...args);
          const result = [];
          for (const row of cursor) {
            if (row.bytes === null) break;
            result.push([row.seq, row.kind, row.bytes.byteLength, row.appended_at]);
          }
          return Response.json({ result, rowsRead: cursor.rowsRead });
        }
      }
      export default { fetch(req, env) { return env.LOG.getByName("collection").fetch(req); } };
    `,
  }));
  try {
    const probe = async arm => {
      const reply = await mf.dispatchFetch("http://bench.local/" + arm);
      assert.equal(reply.status, 200);
      return reply.json();
    };
    const before = await probe("before"), after = await probe("after");
    const expected = Array.from({ length: 64 }, (_, i) => [i + 1, 1, 16384, i + 1]);
    assert.deepEqual(before.result, expected);
    assert.deepEqual(after.result, expected);
    assert.ok(after.rowsRead < before.rowsRead, "byte-limited cursor must stop early");
    console.log("workerd rowsRead for 64 x 16 KiB", { before: before.rowsRead, after: after.rowsRead });
  } finally {
    await mf.dispose();
  }
}
