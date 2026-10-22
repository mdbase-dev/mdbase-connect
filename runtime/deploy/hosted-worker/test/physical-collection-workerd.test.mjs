// Actual local workerd opaque IDs and two independent SQLite namespaces.
// No CPP, custody, native WASM, pending/commit authority or H1 permission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const collection = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const compiled = await build({ stdin: {
  contents: `
    import { HostedCollection } from "./src/worker.ts";
    class Probe extends HostedCollection {
      async fetch(request) {
        try {
          this.requirePhysicalCollection(new URL(request.url).searchParams.get("expected"));
          return Response.json({ mapped: true }); // TEST DATA only; not permission.
        } catch (error) {
          if (error.message !== "physical_collection_mismatch") throw error;
          return new Response("mismatch", { status: 409 });
        }
      }
    }
    export class ProbeA extends Probe {}
    export class ProbeB extends Probe {}
    export default { fetch(request, env) {
      const q = new URL(request.url).searchParams;
      const ns = q.get("namespace") === "other" ? env.OTHER : env.COLLECTIONS;
      let id = ns.idFromName(q.get("address"));
      if (q.get("string") === "1") id = ns.idFromString(id.toString());
      return ns.get(id).fetch(request);
    } };
  `,
  resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "physical-harness.ts", loader: "ts"
}, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"], plugins: [{
  name: "no-native-runtime", setup(b) {
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "absent", namespace: "no-wasm" }));
    b.onLoad({ filter: /.*/, namespace: "no-wasm" }, () => ({ contents: "export default undefined;" }));
  }
}] });

test("actual actor identity must equal UUID mapping in the actual bound namespace, including string-ID reopen", async () => {
  const prefix = fileURLToPath(new URL("../.test-state/physical-", import.meta.url));
  mkdirSync(dirname(prefix), { recursive: true });
  const scratch = mkdtempSync(prefix), oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  let mf; let passed = false;
  try {
    mf = new Miniflare(convertV4MiniflareOptions({ name: "physical-source-test", modules: true,
      script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-05", port: 0,
      durableObjects: { COLLECTIONS: { className: "ProbeA", useSQLite: true }, OTHER: { className: "ProbeB", useSQLite: true } },
      resourcePersistencePath: scratch, resourceTmpPath: scratch
    }));
    const call = input => mf.dispatchFetch(`http://fixture.test/?${new URLSearchParams(input)}`);
    assert.equal((await call({ address: collection, expected: collection })).status, 200);
    assert.equal((await call({ address: collection, expected: other })).status, 409);
    // Equal caller labels cannot substitute another namespace's actual object.
    assert.equal((await call({ namespace: "other", address: collection, expected: collection })).status, 409);
    assert.equal((await call({ address: collection, expected: collection, string: "1" })).status, 200);
    await mf.dispose(); mf = undefined;
    passed = true;
  } finally {
    await mf?.dispose();
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    if (passed) rmSync(scratch, { recursive: true });
    else console.error(`Retained isolated physical fixture: ${scratch}`);
  }
});
