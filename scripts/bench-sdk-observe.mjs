// Synthetic comparison with the editor's replaced serial watch worker.
// Run: node --expose-gc scripts/bench-sdk-observe.mjs [output.json]
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "packages/client/package.json"));
const { build } = require("esbuild");
const scratch = await mkdtemp(join(tmpdir(), "sdk-observe-bench-"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const file = join(scratch, "sdk.mjs");
  await build({ stdin: { contents: `export { MdbaseCollectionClient } from ${JSON.stringify(join(root, "packages/client/src/collection-client.ts"))};`, resolveDir: root }, bundle: true, platform: "node", format: "esm", outfile: file, alias: { "@mdbase-dev/connect-protocol": join(root, "packages/protocol/src/index.ts") } });
  const { MdbaseCollectionClient } = await import(pathToFileURL(file).href);
  const count = Number(process.env.RECORDS ?? 50_000), changed = 200;
  const rows = Array.from({ length: count }, (_, i) => ({ path: `${i}.md`, revision: "r1", types: ["note"], frontmatter: { title: `Note ${i}`, padding: "x".repeat(256) }, effective_frontmatter: { title: `Note ${i}`, padding: "x".repeat(256) }, body: "x".repeat(2048), file: { tags: [], links: [], embeds: [] } }));
  let writeGeneration = 1;
  function authority() {
    let cursor = 0, requests = 0, bytes = 0, active = 0, maximum = 0;
    let events = [], token = 0;
    const pages = new Map();
    const client = new MdbaseCollectionClient({ async operation(op, input) {
      requests++; active++; maximum = Math.max(maximum, active); await sleep(2); active--;
      let result;
      if (op === "changes") {
        const selected = events.filter(event => event.cursor > (input.after ?? cursor)).slice(0, input.limit ?? 200);
        result = { cursor: selected.at(-1)?.cursor ?? cursor, events: selected, has_more: selected.length > 0 && selected.at(-1).cursor < cursor, reset: false };
      } else if (op === "query") {
        if (input.release_cursor) {
          pages.delete(input.release_cursor);
          return { valid: true, diagnostics: [], result: { results: [] } };
        }
        if (input.cursor) {
          const saved = pages.get(input.cursor);
          assert.ok(saved, "single-use query cursor"); pages.delete(input.cursor);
          input = { ...saved, limit: input.limit ?? saved.limit };
        }
        const scope = input.where?.match(/file.path in (\[.*?\])/);
        const paths = scope ? new Set(JSON.parse(scope[1])) : null;
        const selected = paths ? rows.filter(row => paths.has(row.path)) : rows;
        const offset = input.offset ?? 0, page = selected.slice(offset, offset + (input.limit ?? 1000));
        const hasMore = offset + page.length < selected.length, next = hasMore ? `page-${++token}` : undefined;
        if (next) pages.set(next, { ...input, offset: offset + page.length });
        result = { valid: true, diagnostics: [], result: {
          ...(input.output ? { output: input.output } : {}),
          results: input.output === "metadata" ? page.map(row => ({ path: row.path, revision: row.revision, types: row.types, values: Object.fromEntries((input.select ?? []).map(field => [field, row.file[field.slice(5)]])) })) : page.map(({ body, ...row }) => input.include_body ? { ...row, body } : row),
          meta: { has_more: hasMore, total_count: selected.length, ...(next ? { cursor: next } : {}) }
        } };
      } else if (op === "read") {
        const document = path => {
          const row = rows[Number(path.replace(".md", ""))];
          const { body, ...source } = row;
          const rest = { ...source, file: {} }; // Document reads omit query-derived fields.
          return !input.paths || input.include_body ? { ...rest, body, ...(!input.paths && input.include_document ? { document: `---\ntitle: ${rest.frontmatter.title}\n---\n${body}` } : {}) } : rest;
        };
        result = { valid: true, diagnostics: [], result: input.paths ? { items: input.paths.map(path => ({ path, status: "found", record: document(path) })) } : document(input.path) };
      } else throw new Error(op);
      const encoded = JSON.stringify(result);
      bytes += Buffer.byteLength(encoded); return JSON.parse(encoded);
    } }, null, async () => ({ ok: true, value: true, diagnostics: [] }));
    return { client, metrics: () => ({ requests, responseBytes: bytes, maximumOutstanding: maximum }), clear() { requests = bytes = maximum = 0; },
      burst() {
        const revision = `r${++writeGeneration}`;
        for (let i = 0; i < changed; i++) { rows[i].revision = revision; rows[i].body = "x".repeat(2040) + String(writeGeneration).padStart(8, "0"); }
        events = Array.from({ length: 1000 }, (_, i) => ({ cursor: ++cursor, type: "mdbase.record.modified", occurred_at: "now", payload: { path: `${i % changed}.md`, revision, body_changed: true } }));
      } };
  }
  const results = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const mode of ["serial-editor-worker", "observe"]) {
      global.gc?.(); const heap = process.memoryUsage().heapUsed, f = authority();
      let observer, index;
      const initial = performance.now();
      if (mode === "observe") {
        observer = f.client.observe({ frontmatterMode: "both" }, { pageSize: 1000, coalesceMs: 10, watch: { pollIntervalMs: 100 } });
        assert.equal((await observer.ready).ok, true);
        assert.equal(observer.getSnapshot().records.length, count);
      } else {
        const initial = await f.client.queryAll({ frontmatterMode: "both" }, { pageSize: 1000 });
        assert.equal(initial.ok, true);
        index = new Map(initial.value.results.map(row => [row.path, row]));
      }
      const initialMs = performance.now() - initial, initialMetrics = f.metrics(); f.clear();
      let updates = 0, notifications = 0;
      observer?.subscribe((snapshot, delta) => { notifications++; if (delta.reason === "changes") updates += delta.upserts.length; });
      const start = performance.now();
      f.burst();
      if (observer) {
        while (updates < changed && performance.now() - start < 10000) await sleep(1);
        assert.equal(updates, changed);
      } else {
        // Replaced editor worker: Set coalescing already present, one point read at a time.
        for (let i = 0; i < changed; i++) {
          const loaded = await f.client.read({ path: `${i}.md`, includeDocument: true });
          assert.equal(loaded.ok, true);
          index.set(loaded.value.path, { ...loaded.value, file: { ...index.get(loaded.value.path).file, ...loaded.value.file } });
        }
      }
      const burstMs = performance.now() - start, burstMetrics = f.metrics(), observedHeapGrowth = process.memoryUsage().heapUsed - heap;
      global.gc?.();
      const retainedHeapGrowth = process.memoryUsage().heapUsed - heap;
      if (index) assert.equal(index.size, count); // Keep the baseline index live during GC too.
      results.push({ mode, repeat, initialMs, initial: initialMetrics, burstMs, burst: burstMetrics, notifications, observedHeapGrowth, retainedHeapGrowth });
      observer?.close();
    }
  }
  const output = { node: process.version, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), records: count, events: 1000, uniqueChangedPaths: changed, latencyMs: 2, repeats: results,
    caveat: "Synthetic authority/2ms latency. Serial comparator models the deleted editor worker and excludes change-feed polling (observe includes it); includes no browser rendering or real CEL/index/network costs. Responses JSON round-trip; both indexes stay live for post-GC retained-heap measurements (--expose-gc). Observed heap growth is not peak. Initial observe discovers metadata then reads full projections; it is not a bandwidth-saving claim." };
  console.log(JSON.stringify(output, null, 2));
  if (process.argv[2]) await writeFile(resolve(process.argv[2]), JSON.stringify(output, null, 2) + "\n");
} finally { await rm(scratch, { recursive: true, force: true }); }
