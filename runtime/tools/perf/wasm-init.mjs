#!/usr/bin/env node
// WASM engine init timing: compile, instantiate and first open of the
// dedicated app runtime (`app-runtime.wasm`, the web app / Obsidian engine)
// over a fresh in-memory SQLite index (node:sqlite), as in
// scripts/app-wasm-smoke.mjs. Optionally the same compile + instantiate in an
// isolated headless Chromium (own profile under target/, never a user profile).
//
// Usage:
//   npm ci --prefix packages/sdk
//   node tools/perf/wasm-init.mjs --app target/wasm/app-runtime.wasm [--runs 20]
//        [--chromium <path-to-chrome>]   (needs `npm i --prefix tools/perf playwright-core`)
// Prints JSON: per phase p50/p95 in ms.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { build } from "../../packages/sdk/node_modules/esbuild/lib/main.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const appPath = args.app ?? "target/wasm/app-runtime.wasm";
const runs = Number(args.runs ?? 20);

const dir = new URL("../../target/perf-wasm/", import.meta.url);
mkdirSync(dir, { recursive: true });
await build({ stdin: { contents: 'export * from "../../packages/sdk/src/cbor.ts"; export * from "../../packages/obsidian-runtime/src/index/appIndexHost.ts";', resolveDir: new URL(".", dir).pathname }, bundle: true, platform: "node", format: "esm", outfile: new URL("helpers.mjs", dir).pathname, logLevel: "error" });
const { encode, AppBinaryIndexHost, appSqlHost } = await import(new URL("helpers.mjs", dir));

const pct = (xs, p) => { const v = [...xs].sort((a, b) => a - b); return v[Math.max(1, Math.ceil((p / 100) * v.length)) - 1]; };
const summary = xs => ({ n: xs.length, p50_ms: +pct(xs, 50).toFixed(3), p95_ms: +pct(xs, 95).toFixed(3), max_ms: +pct(xs, 100).toFixed(3) });

class MemIndex {
  constructor() { this.db = new DatabaseSync(":memory:"); this.needsRecovery = false; this.calls = 0; }
  fence() { this.needsRecovery = true; }
  run(batch, limits) {
    this.calls++;
    const db = this.db, tx = batch.mode === "Transaction";
    if (tx) db.exec("BEGIN IMMEDIATE");
    try {
      const out = batch.stmts.map(({ sql, params }) => {
        const stmt = db.prepare(sql); stmt.setReadBigInts(true);
        const a = params.map(p => p.kind === "Null" ? null : p.value);
        const names = stmt.columns().map(c => c.name);
        if (!names.length) { const i = stmt.run(...a); return { columns: 0, values: [], changes: BigInt(i.changes), lastInsertRowid: BigInt(i.lastInsertRowid) }; }
        const values = []; let rows = 0;
        for (const row of stmt.iterate(...a)) {
          if (++rows > limits.maxRows) throw new Error("row limit");
          for (const n of names) { const v = row[n]; values.push(v === null ? { kind: "Null" } : typeof v === "bigint" ? { kind: "Integer", value: v } : typeof v === "number" ? { kind: "Real", value: v } : typeof v === "string" ? { kind: "Text", value: v } : { kind: "Blob", value: new Uint8Array(v) }); }
        }
        return { columns: names.length, values, changes: 0n, lastInsertRowid: 0n };
      });
      if (tx) db.exec("COMMIT");
      return out;
    } catch (e) { if (tx) { try { db.exec("ROLLBACK"); } catch {} } this.fence(); throw e; }
  }
}

const sqliteVersion = (() => { const d = new DatabaseSync(":memory:"); const [a, b, c] = d.prepare("select sqlite_version() AS v").get().v.split(".").map(Number); d.close(); return a * 1_000_000 + b * 1_000 + c; })();
const config = () => encode(new Map([
  [0, 1], [1, new Uint8Array(16).fill(1)], [2, new Uint8Array(16).fill(2)], [3, new Uint8Array(16).fill(3)],
  [4, 37], [5, [new Uint8Array(32).fill(9)]], [6, [new Uint8Array(16).fill(3)]], [7, new Uint8Array(32).fill(8)],
  [8, 0], [9, false], [10, new Uint8Array(32).fill(4)], [11, new Uint8Array(32).fill(5)], [12, 0], [13, sqliteVersion],
]));

const bytes = readFileSync(appPath);
const t = { read: [], compile: [], instantiate: [], open: [], total: [] };
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  const b = readFileSync(appPath);
  const t1 = performance.now();
  const module = await WebAssembly.compile(b);
  const t2 = performance.now();
  let x;
  const index = new MemIndex(), bridge = new AppBinaryIndexHost(index);
  const instance = await WebAssembly.instantiate(module, { env: {
    host_app_sql: appSqlHost(bridge, () => x), host_now_ms: () => Date.now(),
    host_random: (p, n) => { for (let at = 0; at < n; at += 65_536) crypto.getRandomValues(new Uint8Array(x.memory.buffer, p + at, Math.min(65_536, n - at))); },
    host_default_zone: p => { new Uint8Array(x.memory.buffer, p, 3).set(new TextEncoder().encode("UTC")); return 3; },
    host_local_date: (ms, _p, _n, out) => { new Uint8Array(x.memory.buffer, out, 10).set(new TextEncoder().encode(new Date(ms).toISOString().slice(0, 10))); return 10; },
  } });
  x = instance.exports;
  const t3 = performance.now();
  const cfg = config(); const p = x.alloc(cfg.length); new Uint8Array(x.memory.buffer, p, cfg.length).set(cfg);
  const packed = BigInt.asUintN(64, x.rt_app_open(p, cfg.length));
  const op = Number(packed >> 32n), on = Number(packed & 0xffff_ffffn);
  const err = new TextDecoder().decode(new Uint8Array(x.memory.buffer, op, on));
  const t4 = performance.now();
  if (err) throw new Error(`rt_app_open: ${err}`);
  t.read.push(t1 - t0); t.compile.push(t2 - t1); t.instantiate.push(t3 - t2); t.open.push(t4 - t3); t.total.push(t4 - t0);
  index.db.close();
}
const result = { artifact: appPath, bytes: bytes.length, node: process.version, sqlite: sqliteVersion, node_phases: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, summary(v)])) };

if (args.chromium) {
  const { chromium } = await import(new URL("./node_modules/playwright-core/index.mjs", import.meta.url));
  const profile = new URL("../../target/perf-chromium-profile/", import.meta.url).pathname;
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: args.chromium, headless: true });
  try {
    const page = await ctx.newPage();
    await page.route("https://perf.invalid/**", route => route.request().url().endsWith(".wasm")
      ? route.fulfill({ body: bytes, contentType: "application/wasm" })
      : route.fulfill({ body: "<!doctype html><title>perf</title>", contentType: "text/html" }));
    await page.goto("https://perf.invalid/");
    result.chromium = await page.evaluate(async runs => {
      const out = { fetch: [], compileStreaming: [], instantiate: [] };
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const res = await fetch(`https://perf.invalid/app-${i}.wasm`, { cache: "no-store" });
        const t1 = performance.now();
        const module = await WebAssembly.compileStreaming(res);
        const t2 = performance.now();
        const imports = {};
        for (const imp of WebAssembly.Module.imports(module)) { imports[imp.module] ??= {}; imports[imp.module][imp.name] = () => 0; }
        await WebAssembly.instantiate(module, imports);
        const t3 = performance.now();
        out.fetch.push(t1 - t0); out.compileStreaming.push(t2 - t1); out.instantiate.push(t3 - t2);
      }
      return out;
    }, runs);
    result.chromium = Object.fromEntries(Object.entries(result.chromium).map(([k, v]) => [k, summary(v)]));
    result.chromium_version = ctx.browser()?.version() ?? "persistent";
  } finally { await ctx.close(); }
}
console.log(JSON.stringify(result, null, 2));
