// Run the synthetic Rust fixture in seven fresh on-disk Chromium profiles.
// From runtime: rcargo --pull tmp/cold-open.cbor test --release -p mdbn-bench --test catalog_reindex seven_cold_opens_at_10k -- --ignored --nocapture
// node packages/sdk/scripts/cold-open-bench.mjs target/wasm/app-runtime.wasm [comparison.wasm]
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readPackagedSqlite } from "./build-application-assets.mjs";

const { chromium } = createRequire(
  new URL("../../../../apps/editor/package.json", import.meta.url),
)("@playwright/test");
const sqlite = readPackagedSqlite();
const worker = await build({
  entryPoints: [new URL("cold-open-worker.mjs", import.meta.url).pathname],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const routes = new Map([
  ["/", ["text/html", "<!doctype html><title>cold open</title>"]],
  ["/worker.js", ["text/javascript", worker.outputFiles[0].contents]],
  ["/sqlite3.js", ["text/javascript", sqlite.initializer]],
  ["/sqlite3.wasm", ["application/wasm", sqlite.wasm]],
  [
    "/fixture",
    [
      "application/cbor",
      await readFile(
        new URL("../../../target/tmp/cold-open.cbor", import.meta.url),
      ),
    ],
  ],
]);
const variants = await Promise.all(
  process.argv.slice(2).map(async (path) => ({
    path,
    bytes: await readFile(path),
  })),
);
if (!variants.length) throw Error("Pass at least one app-runtime WASM path");
const server = createServer((req, res) => {
  const asset = routes.get(req.url);
  res.writeHead(asset ? 200 : 404, {
    "content-type": asset?.[0] ?? "text/plain",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  });
  res.end(asset?.[1]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  for (let run = 1; run <= 7; run++) {
    for (const variant of run % 2 ? variants : [...variants].reverse()) {
      routes.set("/runtime.wasm", ["application/wasm", variant.bytes]);
      const profile = await mkdtemp(join(tmpdir(), "mdbase-cold-open-"));
      try {
        const context = await chromium.launchPersistentContext(profile, {
          headless: true,
        });
        try {
          const page = await context.newPage();
          page.on("console", (msg) => {
            if (msg.type() === "error") console.error(msg.text());
          });
          await page.goto("http://127.0.0.1:" + server.address().port);
          const result = await page.evaluate(
            () =>
              new Promise((resolve, reject) => {
                const worker = new Worker("/worker.js", { type: "module" });
                const timeout = setTimeout(() => {
                  worker.terminate();
                  reject(Error("cold open timed out"));
                }, 180000);
                worker.onerror = (e) => {
                  clearTimeout(timeout);
                  reject(Error(e.message));
                };
                worker.onmessage = ({ data }) => {
                  clearTimeout(timeout);
                  worker.terminate();
                  data.error ? reject(Error(data.error)) : resolve(data.value);
                };
              }),
          );
          console.log(
            JSON.stringify({ run, variant: variant.path, ...result }),
          );
        } finally {
          await context.close();
        }
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    }
  }
} finally {
  server.close();
}
