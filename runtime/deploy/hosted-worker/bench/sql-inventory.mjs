// Node 24, from the repository root. Supply the original module from the PR base:
// git show <base>:runtime/deploy/hosted-worker/src/sql.ts > /tmp/base-sql.ts
// node --experimental-transform-types runtime/deploy/hosted-worker/bench/sql-inventory.mjs /tmp/base-sql.ts
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { runIndex } from "../src/sql.ts";

const base = await import(pathToFileURL(process.argv[2]).href);
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE st_rec(id BLOB PRIMARY KEY, path_key TEXT NOT NULL, bucket INTEGER NOT NULL, row BLOB NOT NULL) WITHOUT ROWID");
const insert = db.prepare("INSERT INTO st_rec VALUES(?,?,?,?)");
function id(i) {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(i, 12);
  return bytes;
}
const total = 4096, page = 1024;
for (let i = 0; i < total; i++) insert.run(id(i), `notes/${i}.md`, i % 16, Buffer.alloc(512, i % 256));

let queries = 0;
const storage = { sql: { exec(sql, ...params) {
  queries++;
  const stmt = db.prepare(sql);
  // node:sqlite binds anonymous parameters positionally and ?1 by name.
  const bindings = params.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  const args = sql.includes("?1") ? [Object.fromEntries(bindings.map((v, i) => [i + 1, v]))] : bindings;
  return {
    get columnNames() { return stmt.columns().map(c => c.name); },
    one() { return stmt.get(...args); },
    *raw() {
      stmt.setReturnArrays(true);
      for (const row of stmt.iterate(...args)) {
        yield row.map(v => {
          if (!(v instanceof Uint8Array)) return v;
          // Durable Object SQL exposes BLOBs as ArrayBuffers.
          assert.equal(v.byteLength, v.buffer.byteLength);
          return v.buffer;
        });
      }
    },
  };
} } };

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function string(s) {
  const bytes = Buffer.from(s);
  return Buffer.concat([u32(bytes.length), bytes]);
}
function request(sql, ...params) {
  const parts = [Buffer.from([77, 68, 66, 73, 68, 88, 0, 1, 0, 1]), u32(1), string(sql), u32(params.length)];
  for (const v of params) {
    if (typeof v === "number") {
      const n = Buffer.alloc(8);
      n.writeBigInt64LE(BigInt(v));
      parts.push(Buffer.of(1), n);
    } else parts.push(Buffer.of(4), u32(v.length), v);
  }
  return Uint8Array.from(Buffer.concat(parts));
}
// Replay the snapshot builder's SqlStore::records pages including the final
// empty page. Synthetic 512-byte rows are opaque to the host. A 1024-row
// page fits the native 2 MiB group budget, so each page has one range read.
const meta = "SELECT id, length(row) FROM st_rec WHERE 1";
const payload = "SELECT id, row FROM st_rec WHERE id >= ?1 AND id <= ?2 ORDER BY id";
const requests = [];
for (let i = 0; i <= total; i += page) {
  const after = i > 0 ? [id(i - 1)] : [];
  requests.push(request(meta + (i ? " AND id > ?" : "") + " ORDER BY id LIMIT ?", ...after, page));
  if (i < total) requests.push(request(payload, id(i), id(i + page - 1)));
}
for (const [i, req] of requests.entries()) {
  const original = base.runIndex(storage, req);
  assert.equal(original[8], 2, "expected a result");
  const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const rows = i === requests.length - 1 ? 0 : page;
  assert.equal(view.getUint32(33, true), rows * 2, "expected both columns of every row");
  const idBytes = 1 + 4 + 16;
  const valueBytes = i % 2 ? 1 + 4 + 512 : 1 + 8;
  assert.equal(original.length, 37 + rows * (idBytes + valueBytes));
  assert.deepEqual(runIndex(storage, req), original);
}

function inventory(run) {
  for (const req of requests) assert.equal(run(storage, req)[8], 2);
}
const variants = [{ name: "before", run: base.runIndex }, { name: "after", run: runIndex }];
const metrics = Object.fromEntries(variants.map(v => [v.name, { wall: [], cpu: [], heap: [] }]));
for (let i = 0; i < 4; i++) for (const v of variants) inventory(v.run);
const order = i => i % 2 ? [...variants].reverse() : variants;
for (let round = 0; round < 24; round++) {
  for (const { name, run } of order(round)) {
    queries = 0;
    const cpu = process.cpuUsage(), start = performance.now();
    inventory(run);
    metrics[name].wall.push(performance.now() - start);
    const elapsed = process.cpuUsage(cpu);
    metrics[name].cpu.push((elapsed.user + elapsed.system) / 1000);
    metrics[name].queries = queries;
  }
}

// Sample V8 heap allocations, including collected objects, separately from
// timing. ArrayBuffer backing stores are external to this estimate.
const session = new Session();
session.connect();
const sum = node => node.selfSize + node.children.reduce((n, child) => n + sum(child), 0);
for (let round = 0; round < 4; round++) {
  for (const { name, run } of order(round)) {
    await session.post("HeapProfiler.startSampling", { samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    inventory(run);
    const { profile } = await session.post("HeapProfiler.stopSampling");
    metrics[name].heap.push(sum(profile.head) / (1024 * 1024));
  }
}
session.disconnect();
db.close();
function percentile(samples, p) {
  return Number([...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1].toFixed(2));
}
console.table(Object.fromEntries(Object.entries(metrics).map(([name, m]) => [name, {
  p50_ms: percentile(m.wall, 0.5), p95_ms: percentile(m.wall, 0.95),
  p50_cpu_ms: percentile(m.cpu, 0.5), p50_sampled_heap_MiB: percentile(m.heap, 0.5),
  sql_calls: m.queries,
}])));
