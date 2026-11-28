// Node 24, after npm ci in runtime/deploy/cloudflare-do, from a Git checkout. Pass the commit whose pull query is the baseline.
// node runtime/deploy/cloudflare-do/bench/pull-pages.mjs <base-commit>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const rust = "runtime/deploy/cloudflare-do/src/lib.rs";
const limit = 1000;
const workloads = [
  { name: "512 B, item-limited", start: 0, end: 10000, cap: 8 << 20 },
  { name: "16 KiB, byte-limited", start: 10000, end: 20000, cap: 1 << 20 },
  { name: "sparse controls", start: 0, end: 20000, cap: 1 << 20, control: true },
];

// Both variants run the SQL from the Rust adapter, with its actual control filter.
function pullQuery(source, control) {
  const method = source.slice(source.indexOf("    async fn items("), source.indexOf("    async fn tokens("));
  const query = method.match(/let q = format!\(\s*"([^"]+)"/)[1];
  const filter = method.match(/if control_only \{ "([^"]+)"/)[1];
  return query.replace("{filter}", control ? filter : "");
}

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE items(seq INTEGER PRIMARY KEY, kind INTEGER NOT NULL, bytes BLOB NOT NULL, appended_at INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO items VALUES(?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 1; i <= 20000; i++) {
    insert.run(i, i % 100 === 0 ? 2 : 1, Buffer.alloc(i <= 10000 ? 512 : 16384, i % 256), i);
  }
  db.exec("COMMIT");
  db.close();
}

function measure(arm, path, sql, workload) {
  const { start, end, cap, control } = workload;
  const db = new DatabaseSync(path, { readOnly: true });
  const query = db.prepare(sql);
  const bindings = after => arm === "before" ? [after, limit, cap] : [cap, after, limit];
  const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(...bindings(start)).map(row => row.detail);
  let after = start, pages = 0, count = 0, bytes = 0;
  const cpu = process.cpuUsage(), started = performance.now();
  while (after < end) {
    const previous = after;
    const rows = arm === "before" ? Array.from(query.iterate(...bindings(after))) : query.iterate(...bindings(after));
    for (const row of rows) {
      if (row.bytes === null) break;
      assert.equal(row.seq, after + (control ? 100 : 1));
      assert.equal(row.kind, row.seq % 100 === 0 ? 2 : 1);
      assert.equal(row.appended_at, row.seq);
      assert.equal(row.bytes.length, row.seq <= 10000 ? 512 : 16384);
      assert.equal(row.bytes[0], row.seq % 256);
      after = row.seq;
      count++;
      bytes += row.bytes.length;
    }
    assert.ok(after > previous);
    pages++;
  }
  const wallMs = performance.now() - started, used = process.cpuUsage(cpu);
  assert.equal(after, end);
  db.close();
  return { wallMs, cpuMs: (used.user + used.system) / 1000, peakMiB: process.resourceUsage().maxRSS / 1024,
    pages, count, bytes, plan };
}

if (process.argv[2] === "--seed") {
  seed(process.argv[3]);
} else if (process.argv[2] === "--sample") {
  console.log(JSON.stringify(measure(process.argv[3], process.argv[4], process.argv[5], JSON.parse(process.argv[6]))));
} else {
  const base = process.argv[2];
  assert.ok(base, "pass a base commit");
  const sources = {
    before: execFileSync("git", ["show", base + ":" + rust], { encoding: "utf8" }),
    after: readFileSync(new URL("../src/lib.rs", import.meta.url), "utf8"),
  };
  const dir = mkdtempSync(join(tmpdir(), "do-pull-"));
  try {
    const path = join(dir, "items.db");
    execFileSync(process.execPath, [script, "--seed", path]);
    for (const workload of workloads) {
      const samples = { before: [], after: [] };
      // A warmup pair followed by six alternating AB/BA pairs. Each process
      // opens the same read-only DB with a fresh pager, V8 heap and RSS peak.
      for (let pair = 0; pair <= 6; pair++) {
        for (const arm of pair % 2 ? ["after", "before"] : ["before", "after"]) {
          const sql = pullQuery(sources[arm], workload.control);
          const result = JSON.parse(execFileSync(process.execPath,
            [script, "--sample", arm, path, sql, JSON.stringify(workload)], { encoding: "utf8" }));
          if (pair) samples[arm].push(result);
        }
      }
      for (const key of ["pages", "count", "bytes"]) {
        assert.equal(samples.before[0][key], samples.after[0][key]);
      }
      for (const [arm, runs] of Object.entries(samples)) {
        const median = key => {
          const sorted = runs.map(run => run[key]).sort((a, b) => a - b);
          return ((sorted[2] + sorted[3]) / 2).toFixed(1);
        };
        console.log(workload.name, arm, { pages: runs[0].pages, items: runs[0].count,
          wallMs: median("wallMs"), cpuMs: median("cpuMs"), peakMiB: median("peakMiB"), plan: runs[0].plan });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { checkWorkerdRows } = await import("./pull-rows-workerd.mjs");
  await checkWorkerdRows({ before: pullQuery(sources.before), after: pullQuery(sources.after) });
}
