// Prerequisites in addition to the SDK private-device local runner: install the hosted
// Worker dependencies, build the local Worker WASM from runtime/ with
// rcargo --pull wasm32-unknown-unknown/wasm-release/mdbn_hosted_worker.wasm build --locked --target wasm32-unknown-unknown --profile wasm-release -p mdbn-hosted-worker --features local-rehearsal
// and run pnpm --filter mdbase-editor build:e2e. From the repository root:
// TMPDIR=/tmp PLAYWRIGHT_MODULE="$PWD/apps/editor/node_modules/@playwright/test/index.mjs" MDBASE_E2E_CARGO=rcargo fnm exec --using 24.22.2 node runtime/packages/sdk/scripts/app-private-device-local-e2e.mjs --editor-offline
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { availableTcpPort, poll } from "../../../scripts/lib/test-runtime.mjs";

// Start real hosted/escrow Workers for this one local cloud copy. The same
// verified local trust module is compiled into the browser and both Workers.
export async function cloudCopyServices({ checkout, run, sdkLocal, stack, env, cleanup }) {
  const worker = join(checkout, "runtime/deploy/hosted-worker");
  const require = createRequire(join(worker, "package.json"));
  const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
  const { build } = require("esbuild");
  const wasm = await readFile(join(checkout, "runtime/target/wasm32-unknown-unknown/wasm-release/mdbn_hosted_worker.wasm"));
  const literal = join(run, "local-worker-build.mjs");
  await writeFile(literal, "export const LOCAL_REHEARSAL_BUILD = true;\n");
  const { connectOrigin, logOrigin } = stack.config;
  for (const origin of [connectOrigin, logOrigin]) {
    const url = new URL(origin);
    assert.ok(url.origin === origin && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port);
  }
  async function forward(request, origin, target) {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response(null, { status: 403 });
    const destination = new URL(target);
    destination.pathname = url.pathname;
    destination.search = url.search;
    return fetch(destination, {
      method: request.method,
      headers: [...request.headers],
      body: request.body ? await request.arrayBuffer() : undefined,
      redirect: "error",
    });
  }
  const compiled = await build({ entryPoints: [join(worker, "src/worker.ts")], bundle: true, format: "esm",
    platform: "browser", target: "es2022", write: false, external: ["cloudflare:workers"],
    alias: { "#hosted-local-build": literal, "#hosted-release-trust": join(sdkLocal, "src/application/packaged-trust.ts") },
    plugins: [{ name: "native-wasm", setup(builder) {
      // Keep the signed LOG_URL for custody. Use the Worker's service-binding
      // transport for the loopback log, which speaks plain HTTP.
      builder.onResolve({ filter: /^\.\/log\.js$/ }, ({ importer }) =>
        importer === join(worker, "src/worker.ts") ? { path: "local-log", namespace: "loopback" } : null);
      builder.onLoad({ filter: /^local-log$/, namespace: "loopback" }, () => ({
        resolveDir: join(worker, "src"),
        contents: `export * from "./log.ts";
          import { deploymentLog as select } from "./log.ts";
          export const deploymentLog = env => select({ LOG: env.LOG });`,
      }));
      builder.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", external: true }));
    } }] });
  const services = [];
  for (const role of ["hosted", "escrow"]) {
    const port = await availableTcpPort(), prefix = "MDBASE_NEXT_" + role.toUpperCase();
    env[prefix + "_SERVICE_URL"] = `http://127.0.0.1:${port}`;
    services.push({ role, port, prefix });
  }
  return async collectionId => {
    for (const { role, port, prefix } of services) {
      const runtime = new Miniflare(convertV4MiniflareOptions({ name: role, host: "127.0.0.1", port,
        compatibilityDate: "2026-10-05", cf: false,
        modules: [{ type: "ESModule", path: "worker.js", contents: compiled.outputFiles[0].text },
          { type: "CompiledWasm", path: "hosted.wasm", contents: wasm }],
        bindings: { SERVICE_KIND: role, KMS_ENVIRONMENT: "local", CP_URL: connectOrigin, LOG_URL: logOrigin,
          KMS_KEY_ARN: "arn:local:kms:local:000000000000:key/" + randomUUID(), LOCAL_KMS_KEY: randomBytes(32).toString("hex"),
          KMS_COLLECTIONS: collectionId, HOSTED_SERVICE_TOKEN: env[prefix + "_SERVICE_TOKEN"], CP_INBOUND_TOKEN: env[prefix + "_INTERNAL_TOKEN"] },
        durableObjects: { COLLECTIONS: { className: "HostedCollection", useSQLite: true } },
        serviceBindings: { LOG: request => forward(request, "https://log.internal", logOrigin) },
        outboundService: request => forward(request, connectOrigin, connectOrigin),
      }));
      cleanup.push(() => runtime.dispose());
      await runtime.ready;
    }
    // Connect's periodic activation sender only accepts HTTPS deployments.
    // Wake the real actor through its authenticated entry point on this local stack.
    return async () => {
      const response = await fetch(env.MDBASE_NEXT_HOSTED_SERVICE_URL + "/internal/v1/collections/activate", {
        method: "POST", redirect: "error", headers: { "content-type": "application/json",
          authorization: "Bearer " + env.MDBASE_NEXT_HOSTED_SERVICE_TOKEN },
        body: JSON.stringify({ collection: collectionId }),
      });
      if (!response.ok) throw Error(`local hosted activation failed (${response.status})`);
      assert.deepEqual(await response.json(), { activated: true });
    };
  };
}

export async function prepare({ checkout, run, sdkLocal, declaration }) {
  const shell = join(run, "editor-shell");
  const dist = join(checkout, "apps/editor/dist");
  assert.ok(existsSync(join(dist, "tests/fixtures/editor-regressions.html")), "build Editor with build:e2e first");
  await cp(dist, shell, { recursive: true });
  await cp(join(sdkLocal, "dist"), join(shell, "local-sdk"), { recursive: true });
  const sdk = join(sdkLocal, "dist/index.js");
  const { build } = createRequire(import.meta.url)("esbuild");
  await build({ stdin: { resolveDir: checkout, contents: `import {createMdbase} from ${JSON.stringify(sdk)}; export const sdk=createMdbase(${JSON.stringify(declaration)});` },
    outfile: join(shell, "local-sdk/application/editor.js"), bundle: true, format: "esm", platform: "browser" });
  const { buildOfflineShell } = await import(pathToFileURL(join(sdkLocal, "dist/offline-shell-build.js")));
  await buildOfflineShell({ directory: shell, register: false });
  return shell;
}

export function serve(shell, path, response) {
  const file = resolve(shell, "." + path);
  if (!file.startsWith(shell + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  const mime = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json",
    ".html": "text/html", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
  response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
  return true;
}

const trials = [["control", true, false], ["A", true, true], ["B", false, true]];

export async function seedTrials({ folder, mdbase, collectionId }) {
  for (const [trial] of trials) {
    const path = `offline-${trial}.md`;
    await writeFile(join(folder, path), `BASE_${trial}\n`);
  }
  await poll(async () => {
    for (const [trial] of trials) {
      const record = await mdbase(["read", `offline-${trial}.md`, "-C", folder]);
      if (record.body !== `BASE_${trial}\n`) return false;
    }
    const collection = (await mdbase(["collection", "list"])).find(c => c.id === collectionId);
    return collection.sync.pending === 0;
  }, "CLI did not sync the seed bodies");
}

async function pendingWrite(page, collectionId, path, body) {
  return page.evaluate(async ({ collectionId, path, body }) => {
    const { sdk } = await import("/local-sdk/application/editor.js");
    const records = sdk.connection(collectionId).records;
    const record = await records.get({ path }, { include: { body: true } });
    if (record.state.state !== "pending" || record.body !== body) return null;
    // With an observed revision the SDK submits body edits. Read the resulting
    // text from the replica and identify its one captured update to this record.
    const entries = (await records.pendingWrites()).filter(write => write.ops.some(op =>
      op.kind === "update" && op.id === record.id && (op.body !== undefined || op.bodyEdits?.length)));
    if (entries.length !== 1) return null;
    const { mutation, state } = await records.receipt(entries[0].receipt.mutation);
    return state === "pending" && mutation === entries[0].receipt.mutation ? mutation : null;
  }, { collectionId, path, body });
}

export async function runTrials({ context, page, appOrigin, collectionId, folder, mdbase }) {
  const body = page.getByRole("textbox", { name: "Note body" });
  const url = new URL("/tests/fixtures/editor-regressions.html", appOrigin);
  url.search = new URLSearchParams({ scenario: "local-stack", collection: collectionId });
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.evaluate(() => navigator.serviceWorker.register("/mdbase-shell-sw.js", { type: "module" }).then(() => undefined));
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  for (const [trial, reload, concurrent] of trials) {
    console.log(`running Editor trial ${trial}`);
    const path = `offline-${trial}.md`, base = `BASE_${trial}`, local = `EDITOR_${trial}`, remote = `CLI_${trial}`;
    const disk = join(folder, path);

    await page.getByText(`offline-${trial}`, { exact: true }).first().click();
    await body.filter({ hasText: base }).waitFor({ timeout: 30_000 });
    let mutationId;
    await context.setOffline(true);
    try {
      // Overlap the same line to force a true body conflict at head.
      await body.fill(local);
      await page.getByText(/saved on this device/i).first().waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => !navigator.onLine);
      mutationId = await poll(() => pendingWrite(page, collectionId, path, local), "missing pending receipt for the edited record");
      if (reload) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
        await body.filter({ hasText: local }).waitFor({ timeout: 30_000 });
        assert.equal(await pendingWrite(page, collectionId, path, local), mutationId, "reload must preserve the exact pending write");
      }
      assert.equal(await readFile(disk, "utf8"), base + "\n", "the offline edit reached the CLI before reconnect");
      if (concurrent) {
        const counters = async () => (await mdbase(["collection", "list"])).find(c => c.id === collectionId).sync;
        const before = await counters();
        await mdbase(["update", path, "--body", remote + "\n", "-C", folder]);
        await poll(async () => {
          const record = await mdbase(["read", path, "-C", folder]);
          const sync = await counters();
          return record.body === remote + "\n" && sync.pending === 0 && sync.confirmed_through > before.confirmed_through;
        }, "the CLI edit did not reach the log", 180, 200);
      }
    } finally { await context.setOffline(false); }
    const terminal = await poll(async () => {
      const receipt = await page.evaluate(async ({ collectionId, mutationId }) => {
        const { sdk } = await import("/local-sdk/application/editor.js");
        const { mutation, state, status } = await sdk.connection(collectionId).records.receipt(mutationId);
        return { mutation, state, status };
      }, { collectionId, mutationId });
      assert.equal(receipt.mutation, mutationId);
      return ["confirmed", "rejected"].includes(receipt.state) && receipt;
    }, "the offline write did not settle", 300, 200);
    console.log(`Editor trial ${trial} exact receipt: ${terminal.state}/${terminal.status ?? "no status"}`);
    if (concurrent) {
      assert.equal(terminal.state, "rejected");
      const recovery = page.getByRole("status", { name: "Unsaved draft found" });
      await recovery.waitFor({ timeout: 60_000 });
      await recovery.getByText("Review recovered text").click();
      assert.equal(await recovery.locator("pre").first().innerText(), local);
      assert.ok((await body.innerText()).includes(remote));
      assert.equal(await readFile(disk, "utf8"), remote + "\n");
      if (trial === "A") {
        await recovery.getByRole("button", { name: "Restore unsaved edits" }).click();
        await page.getByRole("alert", { name: "Note changed elsewhere" }).waitFor();
        await page.getByRole("button", { name: "Keep my edits" }).click();
      } else {
        await recovery.getByRole("button", { name: "Discard recovered edits" }).click();
        await recovery.waitFor({ state: "detached" });
        await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
        await body.filter({ hasText: remote }).waitFor();
        assert.equal(await recovery.count(), 0, "the discarded edit returned after reload");
      }
    }
    if (!concurrent) assert.equal(terminal.state, "confirmed");
    const chosen = trial === "B" ? remote + "\n" : local;
    await poll(async () => (await readFile(disk, "utf8")) === chosen, "the chosen body never reached disk", 300, 200);
    console.log(`ok - Editor offline trial ${trial} (reload=${reload}, concurrent=${concurrent})`);
  }
}
