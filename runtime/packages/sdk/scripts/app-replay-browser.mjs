#!/usr/bin/env node
/** MEASUREMENT ONLY (issue 1648): cold open of a cloud-copy collection by the
 * app runtime composition in real Chromium over real OPFS (opfs-sahpool):
 * AppWasmRuntime + AppBinaryIndexHost + openAppSahpoolIndex + AppHttpLogTransport
 * in one dedicated Worker, as the app host composes them. The log is the local
 * fixture of `crates/daemon/examples/replay_fixture.rs` (public conformance
 * keys, loopback only). It skips the account/device custody layers, which do
 * no work during replay. No accounts, no deployed services.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=/abs/playwright/index.mjs node scripts/app-replay-browser.mjs \
 *     <fixture.json> <app-runtime.wasm> <report.json> [--kill-after <ms>] [--ephemeral] [--headed]
 *
 * `--kill-after` terminates the Worker that long into its first apply of a
 * read page (a reply of 64 KiB or more; the apply is synchronous, so the kill
 * lands inside it unless it has already returned), then opens the same profile
 * again and finishes. `--ephemeral` uses a context
 * without a profile directory, whose OPFS Chromium keeps in memory.
 *
 * It times, inside the Worker: every log reply handed to the runtime (the
 * synchronous apply of one read page), every SQL import call, every SQL batch
 * and statement, BEGIN/COMMIT, and every OPFS access-handle call. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { loadavg } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const killAfter = flag("--kill-after");
const headed = args.includes("--headed") && args.splice(args.indexOf("--headed"), 1).length > 0;
const ephemeral = args.includes("--ephemeral") && args.splice(args.indexOf("--ephemeral"), 1).length > 0;
const [fixturePath, artifact, reportPath] = args;
assert(fixturePath && artifact && reportPath, "fixture, runtime and report paths required");
assert(!(ephemeral && killAfter !== null), "a killed session reopens its profile: not with --ephemeral");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.equal(fixture.publicConformanceFixture, true);
assert.match(fixture.log, /^http:\/\/127\.0\.0\.1:[0-9]+$/);

const pw = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "@playwright/test");
const helpers = (await build({
  stdin: {
    contents: `export {AppWasmRuntime} from './src/app-host/wasm-runtime.ts';
export {AppHttpLogTransport} from './src/app-host/http-log.ts';
export {AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex} from './src/app-storage/app-sqlite-index.ts';
export {MdbaseClient} from './src/client.ts';
export {inProcessConnector} from './src/transport/inprocess.ts';`,
    resolveDir: sdk, sourcefile: "replay-helpers.ts",
  },
  bundle: true, platform: "browser", format: "esm", write: false,
})).outputFiles[0].contents;

// Runs in the Worker.
async function workerProgram() {
  const now = () => performance.now();
  const stats = {
    replies: [], tickMs: 0, ticks: 0, importMs: 0, imports: 0, runMs: 0, batches: { Transaction: 0, Autocommit: 0 },
    statements: 0, exec: {}, steps: {}, sah: {}, timeline: [],
  };
  const bump = (table, key, ms, extra = 0) => { const row = table[key] ??= { n: 0, ms: 0, bytes: 0 }; row.n++; row.ms += ms; row.bytes += extra; };
  const timed = (proto, name, table, key, size) => {
    const original = proto[name];
    proto[name] = function (...a) {
      const t = now();
      try { return original.apply(this, a); } finally { bump(table, key(this, a), now() - t, size ? size(a) : 0); }
    };
  };
  for (const name of ["flush", "write", "read", "truncate", "getSize"])
    timed(FileSystemSyncAccessHandle.prototype, name, stats.sah, () => name, name === "write" || name === "read" ? a => a[0]?.byteLength ?? 0 : null);

  let rt, pump, state, client, current = true, f, start;
  const observe = () => {
    const o = rt.observations(), s = o.status;
    return { confirmed: Number(s.confirmedThrough), head: Number(s.headKnown), pending: Number(s.pending),
      installing: s.installing ? { done: Number(s.installing.done), total: Number(s.installing.total) } : null,
      incidents: s.incidents.length, requiresReopen: o.requiresReopen, rebuilding: o.keyringRebuilding };
  };
  // A batch's own transaction commits through `exec`; a window's through a statement.
  const commits = () => [stats.exec.COMMIT, stats.steps.COMMIT].reduce((a, r) => ({ n: a.n + (r?.n ?? 0), ms: a.ms + (r?.ms ?? 0) }), { n: 0, ms: 0 });
  const totals = () => ({
    imports: stats.imports, importMs: stats.importMs, batches: stats.batches.Transaction + stats.batches.Autocommit,
    transactions: stats.batches.Transaction, commits: commits().n, commitMs: commits().ms,
    flushes: stats.sah.flush?.n ?? 0, flushMs: stats.sah.flush?.ms ?? 0, statements: stats.statements,
  });
  const rpc = async m => {
    if (m.op === "open") {
      f = m.fixture;
      const sqlite = await init({ print: () => {}, printErr: () => {} });
      const sqlText = new WeakMap();
      const prepare = sqlite.oo1.DB.prototype.prepare;
      sqlite.oo1.DB.prototype.prepare = function (sql) { const st = prepare.call(this, sql); sqlText.set(st, String(sql)); return st; };
      timed(sqlite.oo1.DB.prototype, "exec", stats.exec, (_db, a) => typeof a[0] === "string" ? a[0].slice(0, 48) : "other");
      timed(sqlite.oo1.Stmt.prototype, "step", stats.steps, st => sqlText.get(st) ?? "?");
      const t0 = now();
      state = await openAppSahpoolIndex(sqlite, m.scope);
      const openSqlMs = now() - t0;
      const run = state.index.run.bind(state.index);
      state.index.run = (batch, limits) => {
        stats.batches[batch.mode]++; stats.statements += batch.stmts.length;
        const t = now();
        try { return run(batch, limits); } finally { stats.runMs += now() - t; }
      };
      const bridge = new AppBinaryIndexHost(state.index);
      const sql = {
        import: x => { const call = appSqlHost(bridge, x); return (p, n) => { const t = now(); try { return call(p, n); } finally { stats.importMs += now() - t; stats.imports++; } }; },
        fence: () => bridge.fence(), get needsRecovery() { return bridge.needsRecovery; },
      };
      const wasm = new Uint8Array(await (await fetch("/app.wasm")).arrayBuffer());
      rt = await AppWasmRuntime.create(wasm, sql);
      const hex = s => Uint8Array.from(s.match(/../g), b => parseInt(b, 16));
      const v = sqlite.version.libVersion.split(".").map(Number), opened = state.index.info.opened;
      start = now();
      rt.openAppConsuming({ collection: f.collection, replicaId: m.replicaId, deviceId: f.device, endpoint: 37, trustedRoots: [hex(f.root)],
        policyPins: hex(f.pins), trustedSigners: [], expectedGenesis: "sha256:" + f.genesis, state: "cloud_copy", cloudCopyOptIn: true,
        signSecretKey: hex(f.sign), kemSecretKey: hex(f.kem), opened: opened === "Fresh" ? "fresh" : opened === "Unclean" ? "unclean" : "existing",
        sqliteVersion: v[0] * 1000000 + v[1] * 1000 + v[2] });
      const accept = rt.acceptLogReply.bind(rt);
      rt.acceptLogReply = (id, bytes) => {
        const before = totals(), t = now(), length = bytes.length;
        postMessage({ event: "reply", bytes: length });
        const ok = accept(id, bytes), ms = now() - t, after = totals(), o = observe();
        stats.replies.push({ at: t - start, ms, bytes: length, confirmed: o.confirmed, installing: o.installing,
          ...Object.fromEntries(Object.keys(after).map(k => [k, after[k] - before[k]])) });
        return ok;
      };
      const tick = rt.tick.bind(rt);
      rt.tick = () => { const t = now(); try { return tick(); } finally { stats.tickMs += now() - t; stats.ticks++; } };
      const request = (url, opts) => { const u = new URL(url); if (u.origin !== f.log) throw Error("fixture log only"); return fetch("/proxy/log" + u.pathname + u.search, opts); };
      const transport = new AppHttpLogTransport({ endpoint: 37, collection: f.collection, origin: f.log, directOrigins: [], isCurrent: () => current,
        accessToken: async () => f.token, signLogProof: async proof => rt.signLogHttp(proof) }, { allowLoopbackHttp: true, fetch: request });
      pump = rt.bindLogTransport(transport);
      return { opened, openSqlMs, durability: state.index.info.durability, isolated: self.crossOriginIsolated, before: observe() };
    }
    if (m.op === "catch-up") {
      // The host's cold read loop: tick, pump, observe, then a doubling wait.
      let delay = 250, sample = 0;
      for (;;) {
        rt.tick();
        await pump.pump();
        const o = observe(), t = now() - start;
        if (t >= sample) { stats.timeline.push({ t, ...o }); sample = t + 1000; }
        if (o.requiresReopen) throw Error("runtime requires reopen");
        if (o.confirmed >= f.head && !o.installing && o.confirmed >= o.head) { stats.timeline.push({ t, ...o }); return { ...o, wallMs: t }; }
        if (t > 3_600_000) throw Error("catch-up exceeded an hour");
        if (stats.replies.length === 0 || o.confirmed < o.head || o.installing) { await new Promise(r => setTimeout(r, Math.min(delay, 50))); continue; }
        rt.requestLogHead();
        await new Promise(r => setTimeout(r, delay)); delay = Math.min(1000, delay * 2);
      }
    }
    if (m.op === "verify") {
      client = await MdbaseClient.connect({ app: { name: "replay-measurement", version: "1" }, connector: inProcessConnector(rt, { collection: f.collection }), reconnect: false });
      const t = now(), page = await client.query({ limit: 5 }), queryMs = now() - t;
      const tables = state.index.run({ mode: "Autocommit", stmts: [{ sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", params: [] }] })[0].values.map(v => v.value);
      const counts = {};
      for (const name of tables) if (/^[a-z_0-9]+$/i.test(name)) counts[name] = Number(state.index.run({ mode: "Autocommit", stmts: [{ sql: `SELECT count(*) FROM ${name}`, params: [] }] })[0].values[0].value);
      const pragma = sql => state.index.run({ mode: "Autocommit", stmts: [{ sql, params: [] }] })[0].values.map(v => String(v.value));
      return { queryMs, sample: page.records.slice(0, 2).map(r => r.path), counts, pageSize: pragma("PRAGMA page_size"), pageCount: pragma("PRAGMA page_count"),
        journal: pragma("PRAGMA journal_mode"), synchronous: pragma("PRAGMA synchronous"), autocheckpoint: pragma("PRAGMA wal_autocheckpoint") };
    }
    if (m.op === "stats") {
      const top = (table, n) => Object.fromEntries(Object.entries(table).sort((a, b) => b[1].ms - a[1].ms).slice(0, n));
      return { ...stats, commits: commits(), steps: top(stats.steps, 40), stepsTotal: Object.values(stats.steps).reduce((a, r) => ({ n: a.n + r.n, ms: a.ms + r.ms }), { n: 0, ms: 0 }), distinctStatements: Object.keys(stats.steps).length };
    }
    if (m.op === "close") { client?.close(); current = false; const clean = await rt.close(); state.index.close(); await state.pool.pauseVfs(); return { clean }; }
    throw Error("unknown op");
  };
  onmessage = async ({ data: m }) => { try { postMessage({ id: m.id, value: await rpc(m) }); } catch (error) { postMessage({ id: m.id, error: String(error?.stack ?? error) }); } };
}

const packaged = pathToFileURL(resolve(sdk, "node_modules/@sqlite.org/sqlite-wasm/dist") + "/");
const assets = new Map([
  ["/helpers.js", ["text/javascript", helpers]],
  ["/app.wasm", ["application/wasm", await readFile(resolve(artifact))]],
  ["/worker.js", ["text/javascript", `import init from '/sqlite/index.mjs';
import {AppWasmRuntime,AppHttpLogTransport,AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex,MdbaseClient,inProcessConnector} from '/helpers.js';
(${workerProgram.toString()})();`]],
  ["/", ["text/html", `<!doctype html><title>replay measurement</title><script type="module">
const worker=new Worker('/worker.js',{type:'module'});let id=0;
window.rpc=(op,extra={})=>new Promise((yes,no)=>{const rid=++id,on=({data})=>{if(data.id!==rid)return;worker.removeEventListener('message',on);data.error?no(Error(data.error)):yes(data.value);};worker.addEventListener('message',on);worker.postMessage({id:rid,op,...extra});});
window.killAfter=ms=>new Promise(done=>{const on=({data})=>{if(data.event!=='reply'||data.bytes<65536)return;worker.removeEventListener('message',on);setTimeout(()=>{worker.terminate();done(data.bytes);},ms);};worker.addEventListener('message',on);});
</script>`]],
]);
for (const name of ["index.mjs", "sqlite3.wasm", "sqlite3-opfs-async-proxy.js"])
  assets.set(`/sqlite/${name}`, [name.endsWith(".wasm") ? "application/wasm" : "text/javascript", await readFile(new URL(name, packaged))]);

const server = createServer(async (req, res) => {
  try {
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("cross-origin-embedder-policy", "require-corp");
    const asset = assets.get(req.url);
    if (asset) { res.setHeader("content-type", asset[0]); res.end(asset[1]); return; }
    if (!req.url?.startsWith("/proxy/log/v1/")) { res.statusCode = 404; res.end(); return; }
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const headers = {};
    for (const k of ["authorization", "content-type", "accept", "range", "x-mdbase-nonce", "x-mdbase-sig", "origin"])
      if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
    const reply = await fetch(fixture.log + req.url.slice(10), { method: req.method, headers,
      ...(!["GET", "HEAD"].includes(req.method) ? { body: Buffer.concat(chunks) } : {}), redirect: "error" });
    res.statusCode = reply.status;
    for (const k of ["content-type", "content-range", "etag", "x-mdbase-nonce"]) if (reply.headers.has(k)) res.setHeader(k, reply.headers.get(k));
    res.end(Buffer.from(await reply.arrayBuffer()));
  } catch { res.statusCode = 502; res.end("fixture proxy unavailable"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = resolve(sdk, `../../target/replay-browser/profile-${process.pid}`);
await mkdir(profile, { recursive: true });
const scope = { account: randomUUID(), installation: randomUUID(), collection: fixture.collection }, replicaId = randomUUID();

async function session(kill) {
  const browser = ephemeral ? await pw.chromium.launch({ headless: !headed, channel: "chromium" }) : null;
  const context = browser ? await browser.newContext() : await pw.chromium.launchPersistentContext(profile, { headless: !headed, channel: "chromium" });
  try {
    const page = await context.newPage();
    page.on("console", m => { if (m.type() === "error") process.stderr.write(`page: ${m.text()}\n`); });
    await page.goto(origin, { timeout: 120_000 }); // a loaded machine
    await page.waitForFunction(() => typeof window.rpc === "function");
    const rpc = (op, extra) => page.evaluate(([op, extra]) => window.rpc(op, extra), [op, extra]);
    const opened = await rpc("open", { fixture, scope, replicaId });
    if (kill !== null) {
      // A Worker killed mid catch-up: no shutdown, no clean flag, no reply.
      const killing = page.evaluate(ms => window.killAfter(ms), kill);
      rpc("catch-up").catch(() => {});
      return { opened, killedAfterMs: kill, inReplyOfBytes: await killing };
    }
    const caughtUp = await rpc("catch-up");
    const verified = await rpc("verify"), stats = await rpc("stats"), closed = await rpc("close");
    return { opened, caughtUp, verified, stats, closed };
  } finally { await context.close(); await browser?.close(); }
}

const report = { schema: "mdbase-app-replay-browser/1", fixture: { creates: fixture.creates, updates: fixture.updates, head: fixture.head },
  runtime: artifact, storage: ephemeral ? "ephemeral context (in-memory OPFS)" : "persistent profile (OPFS on disk)", loadBefore: loadavg(), sessions: [] };
try {
  if (killAfter !== null) report.sessions.push(await session(Number(killAfter)));
  report.sessions.push(await session(null));
  report.loadAfter = loadavg();
} finally {
  await new Promise(r => server.close(r));
  await rm(profile, { recursive: true, force: true });
  await writeFile(reportPath, JSON.stringify(report, null, 1));
}
for (const s of report.sessions) {
  if (!s.stats) { console.log(JSON.stringify({ opened: s.opened.opened, killedAfterMs: s.killedAfterMs, inReplyOfBytes: s.inReplyOfBytes })); continue; }
  const sum = (k) => s.stats.replies.reduce((a, r) => a + r[k], 0);
  console.log(JSON.stringify({ opened: s.opened.opened, from: s.opened.before.confirmed, confirmed: s.caughtUp.confirmed, wallMs: Math.round(s.caughtUp.wallMs),
    replies: s.stats.replies.length, replyMs: Math.round(sum("ms")), tickMs: Math.round(s.stats.tickMs), importMs: Math.round(s.stats.importMs), imports: s.stats.imports,
    runMs: Math.round(s.stats.runMs), transactions: s.stats.batches.Transaction, autocommit: s.stats.batches.Autocommit,
    commit: s.stats.commits, flush: s.stats.sah.flush, write: s.stats.sah.write, read: s.stats.sah.read, stepMs: Math.round(s.stats.stepsTotal.ms), counts: s.verified?.counts }));
}
