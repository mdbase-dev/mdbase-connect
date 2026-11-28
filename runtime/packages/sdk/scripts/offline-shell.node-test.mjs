import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildOfflineShell } from "../dist/offline-shell-build.js";
import { installOfflineShell } from "../dist/offline-shell-worker.js";

test("public shell build is complete, base-scoped, deterministic, and preserves a notification worker", async () => {
  const dir = await mkdtemp(fileURLToPath(new URL("../.offline-shell-test-", import.meta.url)));
  try {
    await mkdir(`${dir}/assets`);
    await writeFile(`${dir}/index.html`, "<html><head></head><body>shell</body></html>");
    await writeFile(`${dir}/assets/lazy.js`, "export const lazy = true;");
    await writeFile(`${dir}/assets/lazy.js.map`, "debug only");
    await writeFile(`${dir}/service-worker.js`, 'self.addEventListener("push", () => {});');
    const options = { directory: dir, base: "/app/", workerFile: "service-worker.js" };
    const first = await buildOfflineShell(options);
    const second = await buildOfflineShell(options);
    assert.deepEqual(first, second);
    assert.ok(first.assets.some(a => a.path === "assets/lazy.js"));
    assert.ok(!first.assets.some(a => a.path.endsWith(".map") || a.path === "service-worker.js"));
    assert.match(await readFile(`${dir}/index.html`, "utf8"), /src="\/app\/mdbase-shell-register.js"/);
    const worker = await readFile(`${dir}/service-worker.js`, "utf8");
    assert.match(worker, /addEventListener\("push"/);
    assert.equal(worker.match(/installOfflineShell\(self/g).length, 1);
    await writeFile(`${dir}/assets/lazy.js`, "new release");
    assert.notEqual((await buildOfflineShell(options)).version, first.version);
    await assert.rejects(buildOfflineShell({ directory: dir, base: "https://other.test/" }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("shell worker installs only pinned public files; offline navigation works without caching API/auth data", async () => {
  const original = { caches: globalThis.caches, fetch: globalThis.fetch };
  const stores = new Map();
  const deleted = [];
  globalThis.caches = {
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return { put: async (key, value) => store.set(String(key), value), match: async key => store.get(String(key))?.clone() };
    },
    keys: async () => [...stores.keys()],
    delete: async name => { deleted.push(name); return stores.delete(name); },
  };
  const origin = "https://app.test";
  const publicBytes = "public shell";
  const hash = createHash("sha256").update(publicBytes).digest("hex");
  const manifest = { base: "/", version: "one", assets: ["index.html", "404.html", "help/index.html", "assets/lazy.js"].map(path => ({ path, sha256: hash })) };
  const handlers = {};
  let claimed = false;
  let windows = [];
  let activated = false;
  const registration = { installing: null, waiting: null };
  const worker = { location: { origin }, registration, clients: { claim: async () => { claimed = true; }, matchAll: async () => windows }, skipWaiting: async () => { activated = true; }, addEventListener: (type, handler) => { handlers[type] = handler; } };
  const run = async type => { let promise; handlers[type]({ waitUntil: p => { promise = p; } }); await promise; };
  const response = async request => { let promise; handlers.fetch({ request, respondWith: p => { promise = p; } }); return promise; };
  try {
    const fetched = [];
    globalThis.fetch = async (url, options) => {
      fetched.push(url);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      if (url.endsWith(".html")) throw new TypeError("HTML filename redirects are forbidden");
      return new Response(publicBytes);
    };
    installOfflineShell(worker, manifest);
    await run("install");
    assert.deepEqual(fetched, [origin + "/", origin + "/404", origin + "/help/", origin + "/assets/lazy.js"]);
    stores.set("mdbase-shell:/:old", new Map());
    stores.set("mdbase-artifacts:other", new Map());
    await run("activate");
    assert.equal(claimed, true);
    assert.deepEqual(deleted, ["mdbase-shell:/:old"]);
    // A newer deployment's HTML never loads against this release's same-named assets.
    const network = [];
    globalThis.fetch = async request => { network.push(request.url); return new Response("newer deployment"); };
    for (const path of ["/", "/?collection=abc", "/index.html?x=1", "/help/", "/help/?q=1", "/404"]) {
      assert.equal(await (await response({ url: origin + path, method: "GET", mode: "navigate" })).text(), publicBytes, path);
    }
    assert.deepEqual(network, []);
    // A route that names no pinned page is the host's to answer.
    assert.equal(await (await response({ url: origin + "/note/123", method: "GET", mode: "navigate" })).text(), "newer deployment");
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await (await response({ url: origin + "/note/123?callback=sensitive", method: "GET", mode: "navigate" })).text(), publicBytes);
    assert.equal(await (await response({ url: origin + "/", method: "GET", mode: "navigate" })).text(), publicBytes);
    assert.equal(await (await response(new Request(origin + "/assets/lazy.js"))).text(), publicBytes);
    assert.equal(await response(new Request(origin + "/v1/records")), undefined);
    assert.equal(await response(new Request(origin + "/assets/lazy.js?token=sensitive")), undefined);
    assert.equal(await response(new Request("https://connect.test/v1/account")), undefined);
    assert.equal(await response(new Request(origin + "/index.html", { method: "POST" })), undefined);
    assert.deepEqual([...stores.get("mdbase-shell:/:one").keys()], manifest.assets.map(asset => origin + "/" + asset.path));
    // Explicit activation keeps another older tab\u0027s imports, not its auth/API traffic.
    windows = [{ id: "saved", url: origin + "/" }, { id: "older", url: origin + "/note/123" }];
    stores.set("mdbase-shell:/:older", new Map([[origin + "/assets/older.js", new Response("older import")]]));
    let activation;
    handlers.message({ data: { type: "mdbase-shell:activate" }, source: windows[0], waitUntil: p => { activation = p; } });
    await activation;
    assert.equal(activated, true);
    await run("activate");
    assert.equal(stores.has("mdbase-shell:/:older"), true);
    assert.equal(await (await response({ url: origin + "/assets/older.js", method: "GET", destination: "script" })).text(), "older import");
    // Once the older tab leaves, a navigation retires its cache, but never while a
    // newer release is waiting: its cache is one of the others.
    windows = [{ id: "saved", url: origin + "/" }];
    stores.set("mdbase-shell:/:newer", new Map());
    registration.waiting = {};
    let held;
    handlers.fetch({ clientId: "saved", request: { url: origin + "/", method: "GET", mode: "navigate" }, respondWith: p => { held = p; } });
    assert.equal(await (await held).text(), publicBytes);
    assert.equal(stores.has("mdbase-shell:/:older"), true);
    assert.equal(stores.has("mdbase-shell:/:newer"), true);
    registration.waiting = null;
    stores.delete("mdbase-shell:/:newer");
    let navigation;
    handlers.fetch({ clientId: "saved", request: { url: origin + "/", method: "GET", mode: "navigate" }, respondWith: p => { navigation = p; } });
    assert.equal(await (await navigation).text(), publicBytes);
    assert.equal(stores.has("mdbase-shell:/:older"), false);
    // An incomplete/mixed clean-URL deployment cannot activate or destroy the last good cache.
    globalThis.fetch = async url => {
      return new Response("different deployment");
    };
    installOfflineShell(worker, { ...manifest, version: "two" });
    await assert.rejects(run("install"), /changed during deployment/);
    assert.equal(stores.has("mdbase-shell:/:one"), true);
    assert.equal(stores.has("mdbase-shell:/:two"), false);
    // Non-HTML redirects never get another URL or destroy the active release.
    const refused = [];
    globalThis.fetch = async url => {
      refused.push(url);
      if (url.endsWith(".js")) throw new TypeError("redirect");
      return new Response(publicBytes);
    };
    installOfflineShell(worker, { ...manifest, version: "three" });
    await assert.rejects(run("install"), /redirect/);
    assert.equal(refused.at(-1), origin + "/assets/lazy.js");
    assert.equal(stores.has("mdbase-shell:/:one"), true);
    assert.equal(stores.has("mdbase-shell:/:three"), false);

    // A direct-file host can serve HTML even when a clean URL is missing or
    // its SPA fallback renders a different page. Pinned cache keys stay put.
    const direct = [];
    globalThis.fetch = async url => {
      const path = new URL(url).pathname;
      direct.push(path);
      if (path === "/404") return new Response("Not found", { status: 404 });
      if (path === "/help/") return new Response("SPA fallback");
      return new Response(publicBytes);
    };
    installOfflineShell(worker, { ...manifest, version: "direct" });
    await run("install");
    assert.deepEqual(direct, ["/", "/404", "/404.html", "/help/", "/help/index.html", "/assets/lazy.js"]);
    assert.deepEqual([...stores.get("mdbase-shell:/:direct").keys()], manifest.assets.map(asset => origin + "/" + asset.path));
  } finally { globalThis.caches = original.caches; globalThis.fetch = original.fetch; }
});

async function registration(dir) {
  await writeFile(`${dir}/index.html`, "<html><head></head><body></body></html>");
  await buildOfflineShell({ directory: dir });
  return readFile(`${dir}/mdbase-shell-register.js`, "utf8");
}
function page(script, { controlled, waiting }) {
  const posted = [], listeners = [], registered = [];
  let reloads = 0;
  const waitingWorker = waiting ? { postMessage: message => posted.push(message) } : null;
  const navigator = { serviceWorker: {
    controller: controlled ? {} : null,
    register: async (url, options) => { registered.push([url, options]); return { waiting: waitingWorker }; },
    addEventListener: (type, listener, options) => listeners.push({ type, listener, options }),
  } };
  runInNewContext(script, { navigator, location: { reload: () => { reloads++; } }, console });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const controllerChange = () => { for (const l of listeners.filter(l => l.type === "controllerchange")) { l.listener(); } };
  // Objects made inside the page context have its prototypes: compare as JSON.
  const plain = value => JSON.parse(JSON.stringify(value));
  return { posted: () => plain(posted), options: () => plain(listeners.map(l => l.options)), registered: () => plain(registered), settle, controllerChange, reloads: () => reloads };
}

test("a release waiting behind an older controller is activated on app start, with one reload", async () => {
  const dir = await mkdtemp(fileURLToPath(new URL("../.offline-shell-test-", import.meta.url)));
  try {
    const script = await registration(dir);
    const updated = page(script, { controlled: true, waiting: true });
    await updated.settle();
    assert.deepEqual(updated.registered(), [["/mdbase-shell-sw.js", { scope: "/", type: "module" }]]);
    assert.deepEqual(updated.posted(), [{ type: "mdbase-shell:activate" }]);
    assert.equal(updated.reloads(), 0);
    updated.controllerChange();
    assert.equal(updated.reloads(), 1);
    assert.deepEqual(updated.options(), [{ once: true }]);
    // First install: nothing to replace, so no activation and no reload.
    const first = page(script, { controlled: false, waiting: true });
    await first.settle();
    assert.deepEqual(first.posted(), []);
    assert.deepEqual(first.options(), []);
    // Already current: nothing waits.
    const current = page(script, { controlled: true, waiting: false });
    await current.settle();
    assert.deepEqual(current.posted(), []);
    assert.deepEqual(current.options(), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
