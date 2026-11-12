// The SDK in a `blob:` document with a host-constructed `blob:` Worker (the
// `urlSelection` and `worker` options), in a fresh local Chromium context.
// No app accounts, Connect services, existing profiles or production access.
//
// Real: the SDK entry (`createMdbase`), its bundled Worker script, the `blob:`
// iframe and `blob:` module Worker, the Worker bootstrap, the packaged-asset
// selector and loader with the committed pins. Stand-ins: release trust is
// synthetic public trust (as app-sqlite-smoke.mjs), and registration is a
// fixed reply, because there is no Connect. The served `runtime.wasm` is
// deliberately not the pinned bytes: the smoke shows the Worker asks for it
// beside the URL the host's factory was given, and refuses it.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readPackagedSqlite } from "./build-application-assets.mjs";

const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "@playwright/test");
const sdk = new URL("..", import.meta.url).pathname;
const fixtures = { name: "embedded-host-fixtures", setup(builder) {
  builder.onResolve({ filter: /^\.\/(packaged-trust|registration)\.js$/ }, args => args.resolveDir.endsWith("/src/application") ? { path: args.path, namespace: "fixture" } : undefined);
  builder.onLoad({ filter: /packaged-trust/, namespace: "fixture" }, () => ({ contents: `
    export function appReleaseTrust(){return {schema:'mdbn-app-trust/release/1',environment:'lab',
      cpOrigin:'https://cp.test',logOrigin:'https://log.test',assetSha256:'11'.repeat(32),
      source:{repository:'mdbase-dev/mdbase-connect',commit:'22'.repeat(20),version:'test'},
      trustedRoots:[new Uint8Array(32).fill(3)],policyPins:new Uint8Array([4])};}` }));
  builder.onLoad({ filter: /registration/, namespace: "fixture" }, () => ({ contents: `
    export async function resolveApplicationRegistration(){return Object.freeze({id:'55555555-5555-4555-8555-555555555555',name:'Embedded smoke',manifestDigest:'33'.repeat(32)});}` }));
} };
const bundle = async entry => (await build({ absWorkingDir: sdk, entryPoints: [entry], bundle: true, platform: "browser", target: "es2022", format: "esm", write: false, plugins: [fixtures] })).outputFiles[0].contents;
const sqlite = readPackagedSqlite();
const assets = new Map([
  ["/sdk/application/sdk.js", { type: "text/javascript", bytes: await bundle("src/index.ts") }],
  ["/sdk/application/worker.js", { type: "text/javascript", bytes: await bundle("src/application/worker.ts") }],
  ["/sdk/native/sqlite3.js", { type: "text/javascript", bytes: sqlite.initializer }],
  ["/sdk/native/sqlite3.wasm", { type: "application/wasm", bytes: sqlite.wasm }],
  ["/sdk/native/runtime.wasm", { type: "application/wasm", bytes: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]) }],
]);
const requests = [];
const host = `<!doctype html><meta charset="utf-8"><title>Embedding host</title><script type="module">
  // The host page: the SDK runs in a blob: iframe, as in a mobile WebView.
  const engine = \`<!doctype html><meta charset="utf-8"><script type="module">
    import { createMdbase } from "\${location.origin}/sdk/application/sdk.js";
    const origin = location.origin, declaration = { id: "org.example.embedded", name: "Embedded smoke", origin, environment: "lab",
      manifest: { manifest_version: 1, id: "org.example.embedded", name: "Embedded smoke", homepage: origin, redirect_uris: [origin + "/callback"], requirements: { access: "full_collection", contracts: [] } } };
    window.run = async (embedded, namespace) => {
      const factory = { calls: [], workers: [] };
      let options = {};
      if (embedded) {
        const script = await (await fetch(origin + "/sdk/application/worker.js")).text();
        const blob = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
        options = { urlSelection: false, worker: url => { factory.calls.push(url); factory.workers.push(blob); return new Worker(blob, { type: "module" }); } };
      }
      const mdbase = createMdbase({ ...declaration, storage: { applicationNamespace: namespace } }, options);
      const view = () => { const s = mdbase.getSnapshot(); return { status: s.status, problem: s.problem, selection: s.selection.problem, phase: s.phase.kind }; };
      const started = await mdbase.start().then(view, error => ({ error: error.reason ?? error.code ?? String(error) }));
      const opened = embedded ? await mdbase.unsynced.open().then(view, error => ({ error: error.reason ?? error.code ?? String(error) })) : null;
      return { href: location.href, secure: isSecureContext, started, opened, after: view(), factory };
    };
    parent.postMessage("engine-ready", "*");
  <\\/script>\`;
  const frame = document.createElement("iframe");
  frame.src = URL.createObjectURL(new Blob([engine], { type: "text/html" }));
  window.ready = new Promise(resolve => addEventListener("message", event => event.data === "engine-ready" && resolve(true)));
  document.body.append(frame);
</script><body></body>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  requests.push(path);
  if (path === "/") { response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); response.end(host); return; }
  const asset = assets.get(path);
  if (!asset) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" }); response.end(asset.bytes);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true });
async function scenario(embedded, namespace) {
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/`);
    await page.evaluate(() => window.ready);
    const frame = page.frames().find(f => f.url().startsWith("blob:"));
    assert(frame, "the engine runs in a blob: iframe");
    const result = await frame.evaluate(([e, n]) => window.run(e, n), [embedded, namespace]);
    return { ...result, errors };
  } finally { await context.close(); }
}
try {
  // Without the options, a blob: document cannot bind the URL selection (B3).
  const plain = await scenario(false, "embedded-smoke-plain");
  assert.match(plain.href, /^blob:http:\/\/127\.0\.0\.1:/);
  assert.equal(plain.after.selection, "application_selection_binding", JSON.stringify(plain));
  requests.length = 0;
  // With them: the host builds the Worker from a blob: URL; the SDK names it
  // the URL it stands for; the Worker boots and selects its assets beside it.
  const embedded = await scenario(true, "embedded-smoke-hosted");
  assert.equal(embedded.secure, true);
  assert.deepEqual(embedded.factory.calls, [`${origin}/sdk/application/worker.js`], JSON.stringify(embedded));
  assert.match(embedded.factory.workers[0], /^blob:http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(embedded.started, { status: "signed_out", problem: null, selection: null, phase: embedded.started.phase }, JSON.stringify(embedded));
  assert.equal(embedded.after.selection, null);
  // The Worker asked for runtime.wasm beside the factory's URL, not beside its
  // blob: module, and the pins refused the wrong bytes.
  assert(requests.includes("/sdk/native/runtime.wasm"), `runtime.wasm requested: ${JSON.stringify(requests)}`);
  assert.deepEqual(embedded.opened, { error: "application_asset_binding" }, `the unpinned runtime is refused: ${JSON.stringify(embedded)}`);
  assert.deepEqual(embedded.errors, []);
  console.log(JSON.stringify({ plain: plain.after, embedded: { started: embedded.started, opened: embedded.opened, factory: embedded.factory.calls, assetRequests: requests.filter(p => p.startsWith("/sdk/native/")) } }, null, 1));
  console.log("embedded host smoke: ok");
} finally {
  await browser.close();
  server.close();
}
