import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
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
  const worker = { location: { origin }, clients: { claim: async () => { claimed = true; }, matchAll: async () => windows }, skipWaiting: async () => { activated = true; }, addEventListener: (type, handler) => { handlers[type] = handler; } };
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
    assert.deepEqual(fetched, [origin + "/index.html", origin + "/", origin + "/404.html", origin + "/404", origin + "/help/index.html", origin + "/help/", origin + "/assets/lazy.js"]);
    stores.set("mdbase-shell:/:old", new Map());
    stores.set("mdbase-artifacts:other", new Map());
    await run("activate");
    assert.equal(claimed, true);
    assert.deepEqual(deleted, ["mdbase-shell:/:old"]);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await (await response({ url: origin + "/note/123?callback=sensitive", method: "GET", mode: "navigate" })).text(), publicBytes);
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
    // Once the older tab leaves, the new pinned offline navigation can retire its cache.
    windows = [{ id: "saved", url: origin + "/" }];
    let navigation;
    handlers.fetch({ clientId: "saved", request: { url: origin + "/", method: "GET", mode: "navigate" }, respondWith: p => { navigation = p; } });
    assert.equal(await (await navigation).text(), publicBytes);
    assert.equal(stores.has("mdbase-shell:/:older"), false);
    // An incomplete/mixed clean-URL deployment cannot activate or destroy the last good cache.
    globalThis.fetch = async url => {
      if (url.endsWith(".html")) throw new TypeError("redirect");
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
  } finally { globalThis.caches = original.caches; globalThis.fetch = original.fetch; }
});
