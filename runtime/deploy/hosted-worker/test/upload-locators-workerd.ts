// Actual DO SQLite locator correctness; synthetic native callbacks only.
// Does not authenticate native journals or qualify wire ACK/Noise/provider memory.
import { DurableObject } from "cloudflare:workers";
import { UploadLocators, type UploadCipherLocator, type UploadLocatorOwner } from "../src/upload-locators.ts";
import { runIndex } from "../src/sql.ts";
interface Env { LOCATORS: DurableObjectNamespace; }
function check(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function rejects(f: () => unknown, m: string): void { let failed = false;try { f(); } catch { failed = true; }check(failed, m); }
function boundary(n = 1): UploadCipherLocator {
  return { transfer: new Uint8Array(16).fill(n), grant: new Uint8Array(16).fill(2),
    clientPk: new Uint8Array(32).fill(3), account: new Uint8Array(16).fill(4), epoch: 1,
    attachment: new Uint8Array(32).fill(5), cipherHash: new Uint8Array(32).fill(6),
    sealedBytes: 4096, committedChunks: 1, expiresAtMs: 1_700_000_000_000 + 60_000 };
}
export class LocatorFixture extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage, collection = new Uint8Array(16).fill(9);
    let now = 1_700_000_000_000;
    const locators = new UploadLocators(storage, collection, () => now);
    const count = () => storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM hosted_upload_locator_v1").one().n;
    if (new URL(request.url).pathname === "/reopen") {
      const current = boundary(42), found = locators.get(() => current);
      check(found?.committedChunks === 2 && found.cipherHash[0] === 8, "cold process reopen lost locator");
      check(count() === 1, "cold process metadata bound changed");
      check(!storage.sql.exec("SELECT name FROM sqlite_master WHERE name='st_locator_dummy'").toArray().length,
        "disposable store table survived reset");
      return Response.json({ actual_sqlite: true, cold_process_reopen: true,
        untrusted_locator_only: true, native_journal_authentication_required: true, rows: count() });
    }
    const passed: string[] = [];
    const a = boundary();locators.put(() => a);
    check(locators.get(() => a)?.committedChunks === 1 && count() === 1, "known boundary missing");
    locators.put(() => a);check(count() === 1, "identical retry duplicated");passed.push("known-boundary-idempotence");
    let calls = 0;
    const two = { ...a, cipherHash: new Uint8Array(32).fill(8), committedChunks: 2 };
    rejects(() => locators.put(() => ++calls < 3 ? two : null), "lost native gate must rollback SQL");
    check(locators.get(() => a)?.committedChunks === 1, "postwrite current loss claimed progress");passed.push("after-write-native-gate-rollback");
    locators.put(() => two);check(locators.get(() => a)?.committedChunks === 2, "next boundary missing");
    for (const changed of [{ ...two, committedChunks: 1 }, { ...two, committedChunks: 4 },
      { ...two, cipherHash: new Uint8Array(32).fill(7) }, { ...two, epoch: 2 },
      { ...two, attachment: new Uint8Array(32).fill(7) }]) {
      rejects(() => locators.put(() => changed), "progress/immutable drift accepted");
      check(locators.get(() => a)?.committedChunks === 2, "drift changed durable state");
    }
    passed.push("no-regress-jump-repoint-or-context-drift");
    for (const key of ["transfer", "grant", "clientPk", "account"] as const) {
      const wrong = { ...a, [key]: new Uint8Array(a[key].length).fill(99) };
      check(locators.get(() => wrong) === null, "other owner observed locator");
    }
    calls = 0;rejects(() => locators.get(() => ++calls === 1 ? a : null), "lookup owner lost during SQL");
    rejects(() => locators.get(() => null), "revoked owner queried SQL");passed.push("all-owner-fields-and-lookup-currentness");
    calls = 0;rejects(() => locators.remove(() => ++calls < 3 ? a : null), "remove owner lost after SQL");
    check(count() === 1, "remove drift did not rollback");passed.push("remove-postwrite-rollback");
    const before = count();
    for (const changed of [{ ...a, sealedBytes: 65537 }, { ...a, committedChunks: 129 },
      { ...a, committedChunks: 0 }, { ...a, epoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...a, expiresAtMs: now - 1 }, { ...a, expiresAtMs: now + 86_400_001 },
      { ...a, cipherHash: new Uint8Array(33) }, { ...a, transfer: new Uint8Array(17) },
      { ...a, sealedBytes: 3.5 }]) rejects(() => locators.put(() => changed), "bad bound accepted");
    check(count() === before, "bad bound touched progress");passed.push("typed-bounds-expiry-grace-before-write");
    // Exactly fixed metadata columns: there is no arbitrary checkpoint/BLOB body,
    // path, file, digest, plaintext chunk hash or key column.
    const columns = storage.sql.exec<{ name: string }>("PRAGMA table_info(hosted_upload_locator_v1)").toArray().map((r) => r.name);
    check(columns.join(",") === "collection,transfer,grant_id,client_pk,account,epoch,attachment,cipher_hash,sealed_bytes,chunks,expires",
      "unexpected byte/body SQL column");
    check(storage.sql.exec<{ n: number }>("SELECT length(collection)+length(transfer)+length(grant_id)+length(client_pk)+length(account)+length(attachment)+length(cipher_hash) n FROM hosted_upload_locator_v1").one().n === 160,
      "non-metadata bytes stored");passed.push("fixed-160B-identifier-cipher-ref-only-sql");
    for (let i = 2; i <= 64; i++) locators.put(() => boundary(i));
    check(count() === 64, "bounded rows missing");rejects(() => locators.put(() => boundary(65)), "over-budget row admitted");
    check(count() === 64, "budget refusal changed rows");passed.push("64-row-hard-bound");
    now += 60_001;check(locators.get(() => a) === null, "expired locator returned");
    const keep = { ...boundary(42), expiresAtMs: now + 60_000, committedChunks: 2, cipherHash: new Uint8Array(32).fill(8) };
    locators.put(() => keep);check(count() === 1, "expired rows not pruned before bounded insert");passed.push("expired-unreferenced-locators-pruned");
    storage.sql.exec("CREATE TABLE st_locator_dummy(value INTEGER)");
    runIndex(storage, Uint8Array.of(0x4d, 0x44, 0x42, 0x49, 0x44, 0x58, 0x00, 0x01, 1));
    check(locators.get(() => keep)?.committedChunks === 2 && count() === 1, "disposable reset erased locator");
    check(!storage.sql.exec("SELECT name FROM sqlite_master WHERE name='st_locator_dummy'").toArray().length, "store reset not exercised");
    passed.push("real-st-only-materialized-cache-reset-preservation");
    return Response.json({ actual_workerd: true, actual_sqlite: true, synthetic_native_callbacks: true,
      native_wire_noise_provider_qualification: false, passed, rows: count() });
  }
}
export default { fetch(r: Request, env: Env) { return env.LOCATORS.get(env.LOCATORS.idFromName("fixture")).fetch(r); } };
