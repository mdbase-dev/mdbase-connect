// The migration status `verification` projection on real workerd SQLite: the
// native checkpoint bytes (pinned by the Rust test
// `the_verified_checkpoint_bytes_are_pinned_for_the_worker_status`) are stored in
// `mig_checkpoint` and read back through the same `readNativeState` +
// `migrationStatus` the status route returns. Digests and counts only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { decode, encode } from "../../../packages/sdk/src/cbor.ts";

const VERIFIED = "af000101782431303030303030302d303030302d343030302d383030302d3030303030303030303030310208070409f50a110e00140015f5165820a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1175820a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a11818061819185b181a03181b1a0002bf3a";
const verified = new Uint8Array(Buffer.from(VERIFIED, "hex"));
/** The pinned checkpoint with some keys replaced (undefined deletes). */
function variant(changes) {
  const m = new Map(decode(verified));
  for (const [k, v] of Object.entries(changes)) { if (v === undefined) m.delete(Number(k)); else m.set(Number(k), v); }
  return encode(m);
}

const compiled = await build({ stdin: {
  contents: `
    import { DurableObject } from "cloudflare:workers";
    import { migrationStatus, readNativeState } from "./src/migration-run.ts";
    export class Probe extends DurableObject {
      async fetch(request) {
        const sql = this.ctx.storage.sql;
        if (request.method === "PUT") {
          const v = new Uint8Array(await request.arrayBuffer());
          sql.exec("CREATE TABLE IF NOT EXISTS mig_checkpoint(k INTEGER PRIMARY KEY, v BLOB)");
          sql.exec("INSERT INTO mig_checkpoint(k,v) VALUES(0,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", v);
          await this.ctx.storage.sync();
        }
        let native;
        try { native = readNativeState(sql); } catch { native = { error: "migration_state_unreadable" }; }
        return Response.json(migrationStatus(null, native));
      }
    }
    export default { fetch(request, env) { return env.PROBE.getByName("c").fetch(request); } };
  `,
  resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "verification-harness.ts", loader: "ts",
}, bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"] });

test("status carries the verification projection recorded at native step verified, digests and counts only", async () => {
  const prefix = fileURLToPath(new URL("../.test-state/verification-", import.meta.url));
  mkdirSync(dirname(prefix), { recursive: true });
  const scratch = mkdtempSync(prefix);
  const options = () => convertV4MiniflareOptions({ name: "verification-status-test", modules: true,
    script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-05", port: 0,
    durableObjects: { PROBE: { className: "Probe", useSQLite: true } }, resourcePersistencePath: scratch, resourceTmpPath: scratch });
  let mf, passed = false;
  try {
    mf = new Miniflare(options());
    const status = async bytes => {
      const response = await mf.dispatchFetch("http://fixture.test/", bytes ? { method: "PUT", body: bytes } : {});
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await status(), { verification: null, run: null,
      native: { run_sequence: null, checkpoint: null, outstanding: null } }, "no checkpoint, no projection");

    const expected = { records: 91, files: 3, file_bytes: 180026, source_digest: "a1".repeat(32),
      target_digest: "a1".repeat(32), log_head: 6 };
    const body = await status(verified);
    assert.deepEqual(body.verification, expected);
    assert.deepEqual(Object.keys(body.verification), ["records", "files", "file_bytes", "source_digest", "target_digest", "log_head"]);
    assert.equal(body.native.checkpoint.step, 8);
    // Persistent across a runtime restart (it is checkpoint data, not RAM).
    await mf.dispose(); mf = new Miniflare(options());
    assert.deepEqual((await status()).verification, expected);

    // Kept through routed; absent before verified and after a rollback/failure.
    assert.deepEqual((await status(variant({ 2: 13 }))).verification, expected);
    for (const step of [5, 7, 20, 21, 22]) assert.equal((await status(variant({ 2: step }))).verification, null, `step ${step}`);
    // Either side missing: no projection, never a partial one.
    assert.equal((await status(variant({ 22: undefined }))).verification, null);
    assert.equal((await status(variant({ 23: undefined, 24: undefined, 25: undefined, 26: undefined, 27: undefined }))).verification, null);
    // A diverged target is reported as such (the verifier compares; status never decides).
    const diverged = await status(variant({ 23: new Uint8Array(32).fill(0xb2) }));
    assert.equal(diverged.verification.target_digest, "b2".repeat(32));
    assert.notEqual(diverged.verification.target_digest, diverged.verification.source_digest);
    // Malformed facts make the native state unreadable rather than inventing a projection.
    for (const bad of [{ 25: undefined }, { 22: new Uint8Array(31) }, { 26: -1 }]) {
      assert.deepEqual(await status(variant(bad)), { verification: null, run: null, native: { error: "migration_state_unreadable" } });
    }
    passed = true;
  } finally {
    await mf?.dispose();
    if (passed) rmSync(scratch, { recursive: true }); else console.error(`Retained verification fixture: ${scratch}`);
  }
});
