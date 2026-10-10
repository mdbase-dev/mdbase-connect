// The legacy source against REAL Postgres with the provider's own released DDL
// (crates/legacy/fixtures/provider-sql), read as a SELECT-only role. Needs a
// dedicated local test database:
// MDBASE_HOSTED_LEGACY_TEST_PG=postgres://…/…test… (skipped otherwise).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { aad, LegacyCryptoError } from "./crypto.ts";
import {
  LegacySource, LegacySourceError, RECORD_DOCUMENT_CAP, rowBound,
  type ExpectedState, type LegacyObjects, type ReadOnlyTx, type RecordRow,
} from "./source.ts";

const url = process.env.MDBASE_HOSTED_LEGACY_TEST_PG;
const skip = !url || !/test/i.test(new URL(url).pathname) || !["localhost", "127.0.0.1"].includes(new URL(url).hostname);
const CID = "4c18af2e-b04a-4b77-b83e-493c3695962e";
/** A frozen (`migrating`, Connect #592) collection holding a row over the per-row bound. */
const CID2 = "5d29bf3f-c15b-4c88-a94f-5a4d47a6a73f";
/** An active collection with one control-character-heavy record (escaping 6x in JSON). */
const CID3 = "6e3ac040-d26c-4d99-b05e-6b5e58b7b840";
const ESCAPED = `---\ntitle: ctl\n---\n${"\u0001".repeat(600 * 1024)}`;
const HOLD = "11111111-1111-4111-8111-111111111111";
const LAPSING = "33333333-3333-4333-8333-333333333333";
const MASTER = new Uint8Array(32).fill(7);
const DEK = new Uint8Array(32).fill(9);
const READER = { user: "hm_legacy_reader", password: "reader-test-only" };
const enc = new TextEncoder();

async function seal(raw: Uint8Array, plain: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plain));
  const out = new Uint8Array(13 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}
async function rev(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return `sha256:${Buffer.from(d).toString("hex")}`;
}
const rid = (n: number) => `0192f0c1-7e1a-7b3c-8d4e-${n.toString(16).padStart(12, "0")}`;
const doc = (n: number) => `---\ntitle: R${n}\n---\n${"x".repeat(n % 3 === 0 ? 4000 : 100)}\n`;
/** Documents by record number that are not `doc(n)`. */
const BIG: Record<number, string> = {
  601: `---\ntitle: mid\n---\n${"m\"\n".repeat(100 * 1024)}`, // 300 KiB, escaped in JSON
  602: `---\ntitle: big\n---\n${"b".repeat(1536 * 1024)}`, // 1.5 MiB: over the record cap
};
const docOf = (n: number) => BIG[n] ?? doc(n);

let admin: pg.Client;
const objects = new Map<string, Uint8Array>();

async function insertRecord(cid: string, n: number, document: string, sequence: number) {
  const revision = await rev(enc.encode(document));
  const payload = enc.encode(JSON.stringify({ record_id: rid(n), path: `notes/${n}.md`, document, revision }));
  await admin.query(
    `INSERT INTO hosted_provider_records (collection_id, record_id, path_token, revision, content_bytes, payload_ciphertext, sequence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [cid, rid(n), Buffer.from(`p${n}`), revision, enc.encode(document).length,
      await seal(DEK, payload, aad.currentRecord(cid, rid(n), sequence)), sequence]);
}

async function insertCollection(cid: string, head: number, state: string, maxDocumentBytes = 2097152) {
  const wrapped = await seal(MASTER, DEK, aad.collectionKey(cid));
  await admin.query(
    `INSERT INTO hosted_provider_collections (id, template, spec_version, head, max_records, max_content_bytes,
       max_document_bytes, max_mirror_replicas, max_application_replicas, resource_revision, wrapped_data_key,
       resources_ciphertext, timezone, state)
     VALUES ($1, 't', '0.3.0', $2, 10000, 100000000, $5, 10, 10, 'r', $3, '\\x00', 'UTC', $4)`,
    [cid, head, wrapped, state, maxDocumentBytes]);
}

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const dir = resolve(import.meta.dirname, "../../../../crates/legacy/fixtures/provider-sql");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await admin.query(readFileSync(resolve(dir, f), "utf8"));
  }
  // Connect #592 adds the cutover states.
  await admin.query("ALTER TABLE hosted_provider_collections DROP CONSTRAINT hosted_provider_collections_state_check");
  await admin.query(`ALTER TABLE hosted_provider_collections ADD CONSTRAINT hosted_provider_collections_state_check
    CHECK (state IN ('active', 'indexing', 'importing', 'transferring', 'transferred', 'deleting', 'migrating', 'migrated'))`);
  // The SELECT-only reader (crates/legacy/sql/reader-role.sql, plus holds and journal).
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER.user}') THEN
      CREATE ROLE ${READER.user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
    END IF; END $$`);
  await admin.query(`ALTER ROLE ${READER.user} PASSWORD '${READER.password}'`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${READER.user}`);
  await admin.query(`GRANT SELECT ON hosted_provider_collections, hosted_provider_resources, hosted_provider_records,
    hosted_provider_files, hosted_provider_replicas, hosted_provider_changes, hosted_provider_file_changes,
    hosted_provider_resource_changes, hosted_provider_backup_holds, hosted_provider_mutation_journal,
    hosted_provider_mutation_tombstones TO ${READER.user}`);

  await insertCollection(CID, 700, "active");
  await admin.query("INSERT INTO hosted_provider_backup_holds (id, expires_at) VALUES ($1, now() + interval '1 hour')", [HOLD]);
  const cfg = enc.encode("spec_version: \"0.3.0\"\n");
  await admin.query("INSERT INTO hosted_provider_resources (collection_id, path, kind, revision, document_ciphertext) VALUES ($1, 'mdbase.yaml', 'configuration', $2, $3)",
    [CID, await rev(cfg), await seal(DEK, cfg, aad.resourceDocument(CID, "mdbase.yaml"))]);
  for (let n = 1; n <= 602; n++) await insertRecord(CID, n, docOf(n), n);
  const fileBytes = enc.encode("file content ".repeat(1000));
  objects.set("r2/obj-1", fileBytes);
  const filePayload = enc.encode(JSON.stringify({ path: "files/a.bin", content_digest: await rev(fileBytes), media_type: null, media_class: "other" }));
  await admin.query(
    `INSERT INTO hosted_provider_files (collection_id, file_id, path_token, revision, size, object_key, payload_ciphertext, sequence)
     VALUES ($1, $2, 'f1', 'r', $3, 'r2/obj-1', $4, 603)`,
    [CID, rid(9001), fileBytes.length, await seal(DEK, filePayload, aad.currentFile(CID, rid(9001), 603))]);

  // Changes after 650: an update, a delete, a large after-image, a file and a resource.
  const change = async (seq: number, n: number, document: string | null) => {
    const revision = document === null ? "deleted" : await rev(enc.encode(document));
    const after = document === null ? null : await seal(DEK,
      enc.encode(JSON.stringify({ record_id: rid(n), path: `notes/${n}.md`, document, revision })),
      aad.changeRecord(CID, seq, "after"));
    await admin.query(
      `INSERT INTO hosted_provider_changes (collection_id, sequence, record_id, after_ciphertext, revision) VALUES ($1, $2, $3, $4, $5)`,
      [CID, seq, rid(n), after, revision]);
  };
  await change(651, 1, doc(1));
  await change(652, 2, null);
  await change(653, 602, BIG[602]);
  await admin.query(
    `INSERT INTO hosted_provider_file_changes (collection_id, sequence, file_id, revision, after_size, after_object_key, after_ciphertext)
     VALUES ($1, 654, $2, 'r', $3, 'r2/obj-1', $4)`,
    [CID, rid(9001), fileBytes.length, await seal(DEK, filePayload, aad.changeFile(CID, 654, "after"))]);
  await admin.query(
    `INSERT INTO hosted_provider_resource_changes (collection_id, sequence, type_name, path, revision, resource_kind)
     VALUES ($1, 655, 'task', '_types/task.md', 'r', 'type')`, [CID]);

  // Replicas (one revoked) and journal facts (one terminal, one in flight).
  const repl = (id: string, revoked: boolean) => admin.query(
    `INSERT INTO hosted_provider_replicas (id, collection_id, name, purpose, mode, token_hash, revoked_at)
     VALUES ($1::uuid, $2, $5::text, 'mirror', 'read_write', $3, $4)`, [id, CID, Buffer.from(id), revoked ? new Date() : null, `replica ${id}`]);
  await repl(rid(7001), false);
  await repl(rid(7002), true);
  const journal = (req: string, state: string) => admin.query(
    `INSERT INTO hosted_provider_mutation_journal (replica_id, request_id, operation_kind, input_schema_version, input_digest,
       state, process_epoch, lease_owner, lease_expires_at, fencing_generation, final_receipt_ciphertext, receipt_digest,
       completed_at, acknowledged_at)
     VALUES ($1, $2, 'submit', 1, '\\x00', $3, $4, $4, now(), 1, $5, $6, $7, $8)`,
    [rid(7001), req, state, rid(8000), state === "claimed" ? null : Buffer.from([1]),
      state === "claimed" ? null : Buffer.from([0xab, 0xcd]), state === "claimed" ? null : new Date(),
      state === "acknowledged" ? new Date() : null]);
  await journal(rid(8001), "acknowledged");
  await journal(rid(8002), "claimed");

  // A frozen collection at S_final with a row over the per-row bound.
  await insertCollection(CID2, 5, "migrating", 262144);
  await insertRecord(CID2, 1, `---\ntitle: huge\n---\n${"h".repeat(3 * 1024 * 1024)}`, 5);
  await insertCollection(CID3, 1, "active");
  await insertRecord(CID3, 1, ESCAPED, 1);
});

after(async () => {
  if (!skip) await admin.end();
});

function readerUrl(): string {
  const u = new URL(url!);
  u.username = READER.user;
  u.password = READER.password;
  return u.toString();
}

async function source(opts: { isolation?: string; asOwner?: boolean; beforeQuery?: (sql: string) => Promise<void> } = {}) {
  const openTx = async (): Promise<ReadOnlyTx> => {
    const c = new pg.Client({ connectionString: opts.asOwner ? url : readerUrl() });
    await c.connect();
    await c.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? "REPEATABLE READ"} READ ONLY`);
    return {
      async query(sql, params) {
        await opts.beforeQuery?.(sql);
        return (await c.query(sql, params as unknown[])).rows;
      },
      async close() { try { await c.query("ROLLBACK"); } finally { await c.end(); } },
    };
  };
  const store: LegacyObjects = {
    async get(key) {
      const b = objects.get(key);
      if (!b) return null;
      return { size: b.length, body: new ReadableStream({ start(c) { c.enqueue(b.slice(0, 5000)); c.enqueue(b.slice(5000)); c.close(); } }) };
    },
  };
  // Outside the checkpoint transaction: a fresh autocommit statement each time.
  const holdExpiry = async (hold: string): Promise<Date | null> => {
    const c = new pg.Client({ connectionString: readerUrl() });
    await c.connect();
    try {
      const r = await c.query("SELECT expires_at FROM hosted_provider_backup_holds WHERE id = $1::uuid", [hold]);
      return r.rows[0]?.expires_at ?? null;
    } finally {
      await c.end();
    }
  };
  return new LegacySource({
    openTx, holdExpiry, objects: store,
    unwrapper: { environment: "local", legacyMasterKey: await crypto.subtle.importKey("raw", MASTER, "AES-GCM", false, ["decrypt"]) },
  });
}

const signal = () => AbortSignal.timeout(60_000);
const req = { collection: CID, S0: 700, expectedState: "active" as ExpectedState, backupHold: HOLD, retainUntil: "2027-01-01T00:00:00Z" };
const PAGE = { maxRecords: 250, maxDecodedBytes: 262144 };

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

test("pages are bounded, complete and verified; large records come alone by reference and stream", { skip }, async () => {
  const src = await source();
  const { session: s, holdExpiresAt } = await src.openCheckpoint(req, signal());
  assert.ok(Date.parse(holdExpiresAt) > Date.now());
  const seen = new Map<string, RecordRow>();
  const streamed = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await src.nextPage(s, "records", cursor, PAGE, signal());
    assert.ok(page.rows.length <= 250);
    const inline = page.rows.filter((r) => r.document !== null);
    const decoded = inline.reduce((n, r) => n + enc.encode(JSON.stringify(r)).length, 0);
    assert.ok(decoded <= 262144 + 1000 * page.rows.length, "decoded bytes stay near the bound");
    if (page.rows.some((r) => r.contentRef)) assert.equal(page.rows.length, 1, "a large record comes alone");
    for (const r of page.rows) {
      seen.set(r.recordId, r);
      if (r.contentRef) streamed.set(r.recordId, await text(await src.streamRecord(s, r.contentRef, signal())));
    }
    cursor = page.next;
    if (page.done) break;
  }
  assert.equal(seen.size, 602, "every record exactly once, none dropped");
  for (const n of [601, 602]) {
    const r = seen.get(rid(n))!;
    assert.equal(r.document, null);
    assert.equal(r.documentBytes, enc.encode(BIG[n]).length);
    assert.equal(streamed.get(rid(n)), BIG[n], "streamed bytes are exact");
  }
  assert.ok(seen.get(rid(602))!.documentBytes > RECORD_DOCUMENT_CAP, "the importer sees it is over the record cap");
  assert.equal(seen.get(rid(3))!.document, doc(3));
  assert.equal(src.openStreams(s), 0, "finished streams release their controllers");
  const res = await src.nextPage(s, "resources", null, PAGE, signal());
  assert.equal(res.rows[0].path, "mdbase.yaml");
  await src.close(s);
});

test("keyed hydration preserves checkpoint bytes and admits lengths before ciphertext", { skip }, async () => {
  const queries: string[] = [];
  const src = await source({ beforeQuery: async (sql) => { queries.push(sql); } });
  const { session: s } = await src.openCheckpoint(req, signal());
  queries.length = 0;
  const page = await src.hydrateKeys(s, "records", [rid(3), rid(1), rid(2)], PAGE, signal());
  assert.equal(page.done, true);
  assert.deepEqual(page.rows.map((r) => r.recordId), [rid(1), rid(2), rid(3)]);
  assert.deepEqual(page.rows.map((r) => r.document), [doc(1), doc(2), doc(3)]);
  assert.ok(queries[0].includes("length(payload_ciphertext)"));
  assert.ok(!/AS ct\b/.test(queries[0]), "first query admits lengths only");
  assert.ok(/AS ct\b/.test(queries[1]), "only then reads the admitted ciphertext");
  const resource = await src.hydrateKeys(s, "resources", ["mdbase.yaml"], PAGE, signal());
  assert.equal(new TextDecoder().decode(resource.rows[0].document), "spec_version: \"0.3.0\"\n");
  queries.length = 0;
  const code = (c: string) => (e: unknown) => e instanceof LegacySourceError && e.code === c;
  await assert.rejects(src.hydrateKeys(s, "records", [rid(1), rid(1)], PAGE, signal()), code("invalid_request"));
  await assert.rejects(src.hydrateKeys(s, "records", ["not-a-uuid"], PAGE, signal()), code("invalid_request"));
  await assert.rejects(src.hydrateKeys(s, "resources", ["x".repeat((1 << 20) + 1)], PAGE, signal()), code("invalid_request"));
  await assert.rejects(src.hydrateKeys(s, "records", Array.from({ length: 251 }, (_, n) => rid(n)), PAGE, signal()), code("invalid_request"));
  assert.equal(queries.length, 0, "malformed/over-budget keys cause no source query");
  await assert.rejects(src.hydrateKeys(s, "records", [rid(77777)], PAGE, signal()), code("source_changed"));
  assert.ok(queries.every((sql) => !/AS ct\b/.test(sql)), "missing key refused before ciphertext read");
  await src.close(s);

  const bounded = await source({ beforeQuery: async (sql) => { queries.push(sql); } });
  const { session: b } = await bounded.openCheckpoint({ ...req, collection: CID2, S0: 5, expectedState: "migrating" }, signal());
  queries.length = 0;
  await assert.rejects(bounded.hydrateKeys(b, "records", [rid(1)], PAGE, signal()), code("row_too_large"));
  assert.ok(queries.every((sql) => !/AS ct\b/.test(sql)), "over-row-bound key refused before ciphertext read");
  await bounded.close(b);
});

test("page-scoped file/record refs rehydrate and active streams retain their descriptors", { skip }, async () => {
  const src = await source();
  const { session: s } = await src.openCheckpoint(req, signal());
  const code = (c: string) => (e: unknown) => e instanceof LegacySourceError && e.code === c;
  const file = (await src.hydrateKeys(s, "files", [rid(9001)], PAGE, signal())).rows[0];
  const fileStream = await src.streamContent(s, file.sourceRef, signal());
  const large = (await src.hydrateKeys(s, "records", [rid(602)], PAGE, signal())).rows[0];
  await assert.rejects(src.streamContent(s, file.sourceRef, signal()), code("unknown_ref"));
  assert.equal(await text(fileStream), "file content ".repeat(1000), "already-open stream survives ref invalidation");
  const recordStream = await src.streamRecord(s, large.contentRef!, signal());
  await src.hydrateKeys(s, "records", [rid(1)], PAGE, signal());
  await assert.rejects(src.streamRecord(s, large.contentRef!, signal()), code("unknown_ref"));
  assert.equal(await text(recordStream), BIG[602], "active large stream has its immutable descriptor");
  const reread = (await src.hydrateKeys(s, "files", [rid(9001)], PAGE, signal())).rows[0];
  assert.notEqual(reread.sourceRef, file.sourceRef);
  assert.equal(await text(await src.streamContent(s, reread.sourceRef, signal())), "file content ".repeat(1000));
  const empty = await src.hydrateKeys(s, "records", [], PAGE, signal());
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.done, true);
  await assert.rejects(src.streamContent(s, reread.sourceRef, signal()), code("unknown_ref"));
  await src.close(s);
});

test("keyed hydration returns only a bounded prefix and holds the single source-page slot", { skip }, async () => {
  let block = false;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const src = await source({ beforeQuery: async () => { if (block) { entered(); await barrier; } } });
  const { session: s } = await src.openCheckpoint(req, signal());
  const keys = [rid(1), rid(2), rid(3)];
  const first = await src.hydrateKeys(s, "records", keys, { maxRecords: 3, maxDecodedBytes: 1500 }, signal());
  assert.equal(first.done, false);
  assert.deepEqual(first.rows.map((r) => r.recordId), [rid(1), rid(2)]);
  assert.equal(first.next, rid(2));
  const rest = await src.hydrateKeys(s, "records", [rid(3)], PAGE, signal());
  assert.equal(rest.rows[0].document, doc(3));
  block = true;
  const running = src.hydrateKeys(s, "records", [rid(1)], PAGE, signal());
  await ready;
  await assert.rejects(src.nextPage(s, "records", null, PAGE, signal()), (e: unknown) => e instanceof LegacySourceError && e.code === "page_in_flight");
  release();
  await running;
  block = false;
  assert.equal((await src.nextPage(s, "records", null, PAGE, signal())).rows[0].recordId, rid(1), "page slot released");
  await src.close(s);
});

test("active source streams are bounded and cancellation releases the reservation", { skip }, async () => {
  const src = await source();
  const { session: s } = await src.openCheckpoint(req, signal());
  const file = (await src.hydrateKeys(s, "files", [rid(9001)], PAGE, signal())).rows[0];
  const first = await src.streamContent(s, file.sourceRef, signal());
  const second = await src.streamContent(s, file.sourceRef, signal());
  assert.equal(src.openStreams(s), 2);
  await assert.rejects(src.streamContent(s, file.sourceRef, signal()), (e: unknown) => e instanceof LegacySourceError && e.code === "stream_limit");
  await first.cancel();
  assert.equal(src.openStreams(s), 1);
  const third = await src.streamContent(s, file.sourceRef, signal());
  assert.equal(src.openStreams(s), 2);
  assert.equal(await text(second), "file content ".repeat(1000));
  await third.cancel();
  assert.equal(src.openStreams(s), 0);
  await src.close(s);
});

test("only one large row is in flight at a time (decode or stream)", { skip }, async () => {
  const src = await source();
  const { session: s } = await src.openCheckpoint(req, signal());
  const code = (c: string) => (e: unknown) => e instanceof LegacySourceError && e.code === c;
  const small = { maxRecords: 250, maxDecodedBytes: 65536 };
  const first = await src.nextPage(s, "records", rid(600), small, signal());
  assert.equal(first.rows[0].recordId, rid(601));
  const stream = await src.streamRecord(s, first.rows[0].contentRef!, signal());
  // While 601 streams, neither another large page nor another large stream starts.
  await assert.rejects(src.nextPage(s, "records", rid(601), small, signal()), code("large_row_in_flight"));
  await assert.rejects(src.streamRecord(s, first.rows[0].contentRef!, signal()), code("large_row_in_flight"));
  // Small pages still flow.
  assert.equal((await src.nextPage(s, "records", null, { maxRecords: 5, maxDecodedBytes: 65536 }, signal())).rows.length, 5);
  assert.equal(await text(stream), BIG[601]);
  // Released at the end of the stream.
  const second = await src.nextPage(s, "records", rid(601), small, signal());
  assert.equal(second.rows[0].recordId, rid(602));
  const s2 = await src.streamRecord(s, second.rows[0].contentRef!, signal());
  await s2.cancel();
  assert.ok(await src.streamRecord(s, second.rows[0].contentRef!, signal()), "released on cancel too");
  await src.close(s);
});

test("a one-row page may use the whole 1 MiB bound inline", { skip }, async () => {
  const src = await source();
  const { session: s } = await src.openCheckpoint(req, signal());
  const page = await src.nextPage(s, "records", rid(600), { maxRecords: 250, maxDecodedBytes: 1 << 20 }, signal());
  assert.equal(page.rows[0].recordId, rid(601));
  assert.equal(page.rows[0].document, BIG[601], "300 KiB inline under a 1 MiB page bound");
  await src.close(s);
});

test("the checkpoint is fixed: later source writes are invisible inside it", { skip }, async () => {
  const src = await source();
  const { session: s } = await src.openCheckpoint(req, signal());
  await admin.query("UPDATE hosted_provider_records SET revision = 'sha256:changed' WHERE collection_id = $1 AND record_id = $2", [CID, rid(1)]);
  const page = await src.nextPage(s, "records", null, { maxRecords: 5, maxDecodedBytes: 262144 }, signal());
  assert.equal(page.rows[0].recordId, rid(1), "still the checkpoint's row, verified");
  await src.close(s);
  const fresh = await source();
  const { session: s2 } = await fresh.openCheckpoint(req, signal());
  await assert.rejects(fresh.nextPage(s2, "records", null, { maxRecords: 5, maxDecodedBytes: 262144 }, signal()),
    (e: unknown) => e instanceof LegacyCryptoError && e.code === "inconsistent", "a changed row fails its revision check");
  await fresh.close(s2);
  await admin.query("UPDATE hosted_provider_records SET revision = $3 WHERE collection_id = $1 AND record_id = $2",
    [CID, rid(1), await rev(enc.encode(doc(1)))]);
});

test("refusals: wrong head, no hold, not repeatable read, wrong state, a role that can write", { skip }, async () => {
  const src = await source();
  const code = (c: string) => (e: unknown) => e instanceof LegacySourceError && e.code === c;
  await assert.rejects(src.openCheckpoint({ ...req, S0: 599 }, signal()), code("not_at_s0"));
  await assert.rejects(src.openCheckpoint({ ...req, backupHold: "22222222-2222-4222-8222-222222222222" }, signal()), code("no_backup_hold"));
  await assert.rejects(src.openCheckpoint({ ...req, expectedState: "migrating" }, signal()), code("collection_state"));
  const rc = await source({ isolation: "READ COMMITTED" });
  await assert.rejects(rc.openCheckpoint(req, signal()), code("not_a_checkpoint"));
  const owner = await source({ asOwner: true });
  await assert.rejects(owner.openCheckpoint(req, signal()), code("writable_role"));
});

test("S_final: a frozen (migrating) collection opens when expected; an over-bound row is refused and inventoried", { skip }, async () => {
  const src = await source();
  const code = (c: string) => (e: unknown) => e instanceof LegacySourceError && e.code === c;
  await assert.rejects(src.openCheckpoint({ ...req, collection: CID2, S0: 5 }, signal()), code("collection_state"));
  const { session: s } = await src.openCheckpoint({ ...req, collection: CID2, S0: 5, expectedState: "migrating" }, signal());
  const inv = await src.inventory(s, signal());
  assert.deepEqual(inv.records, { total: 1, documentsOverRecordCap: 1, overRowBound: 1 });
  await assert.rejects(src.nextPage(s, "records", null, PAGE, signal()), code("row_too_large"));
  await src.close(s);
  const main = await source();
  const { session: m } = await main.openCheckpoint(req, signal());
  const mi = await main.inventory(m, signal());
  assert.deepEqual(mi.records, { total: 602, documentsOverRecordCap: 1, overRowBound: 0 });
  assert.equal(mi.recordChanges.total, 3);
  await main.close(m);
  assert.ok(rowBound(262144) < 3 * 1024 * 1024, "the bound follows the collection's own quota");
});

test("a provider-valid row whose JSON escaping exceeds 2.5 MiB is streamed, not refused", { skip }, async () => {
  const src = await source();
  const { session: s } = await src.openCheckpoint({ ...req, collection: CID3, S0: 1 }, signal());
  const page = await src.nextPage(s, "records", null, PAGE, signal());
  assert.equal(page.rows.length, 1);
  assert.ok(page.rows[0].contentRef, "over the page bound: by reference");
  assert.equal(await text(await src.streamRecord(s, page.rows[0].contentRef!, signal())), ESCAPED);
  assert.deepEqual((await src.inventory(s, signal())).records, { total: 1, documentsOverRecordCap: 0, overRowBound: 0 });
  await src.close(s);
});

test("the backup hold is re-checked outside the checkpoint before every page and stream", { skip }, async () => {
  await admin.query("INSERT INTO hosted_provider_backup_holds (id, expires_at) VALUES ($1, now() + interval '1 hour')", [LAPSING]);
  const src = await source();
  const { session: s } = await src.openCheckpoint({ ...req, backupHold: LAPSING }, signal());
  const files = await src.nextPage(s, "files", null, PAGE, signal());
  await admin.query("UPDATE hosted_provider_backup_holds SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1", [LAPSING]);
  const code = (c: string) => (e: unknown) => e instanceof LegacySourceError && e.code === c;
  await assert.rejects(src.nextPage(s, "records", null, PAGE, signal()), code("no_backup_hold"));
  await assert.rejects(src.streamContent(s, files.rows[0].sourceRef, signal()), code("no_backup_hold"));
  // The consumer renews; reading resumes and reports the new expiry.
  await admin.query("UPDATE hosted_provider_backup_holds SET created_at = now(), expires_at = now() + interval '3 hours' WHERE id = $1", [LAPSING]);
  const page = await src.nextPage(s, "records", null, { maxRecords: 1, maxDecodedBytes: 262144 }, signal());
  assert.ok(Date.parse(page.holdExpiresAt) > Date.now() + 2 * 3600_000);
  await src.close(s);
});

test("file bytes stream verified; a tampered object errors instead of ending, without leaking its controller", { skip }, async () => {
  const src = await source();
  const { session: s } = await src.openCheckpoint(req, signal());
  const files = await src.nextPage(s, "files", null, { maxRecords: 10, maxDecodedBytes: 262144 }, signal());
  assert.equal(files.rows.length, 1);
  assert.ok(!("objectKey" in files.rows[0]), "the R2 key is never exposed");
  const read = async () => {
    const chunks: Uint8Array[] = [];
    for await (const c of await src.streamContent(s, files.rows[0].sourceRef, signal())) chunks.push(c);
    return Buffer.concat(chunks);
  };
  assert.deepEqual(new Uint8Array(await read()), objects.get("r2/obj-1"));
  const good = objects.get("r2/obj-1")!;
  const long = new Uint8Array(good.length);
  long.set(good);
  long[good.length - 1] ^= 1;
  objects.set("r2/obj-1", long);
  await assert.rejects(read(), (e: unknown) => e instanceof LegacySourceError && e.code === "object_mismatch");
  objects.set("r2/obj-1", good);
  assert.equal(src.openStreams(s), 0, "a failed stream releases its controller");
  await src.close(s);
  await assert.rejects(src.streamContent(s, files.rows[0].sourceRef, signal()), (e: unknown) => e instanceof LegacySourceError && e.code === "no_session");
});

test("changes, replicas and journal facts at the checkpoint", { skip }, async () => {
  const src = await source();
  const { session: s } = await src.openCheckpoint(req, signal());
  const changes = [];
  const streamed = new Map<number, string>();
  let after = 650;
  for (;;) {
    const page = await src.nextChanges(s, after, PAGE, signal());
    changes.push(...page.rows);
    for (const row of page.rows) {
      if (row.kind === "record" && row.after?.contentRef) {
        streamed.set(row.sequence, await text(await src.streamRecord(s, row.after.contentRef, signal())));
      }
    }
    after = Number(page.next);
    if (page.done) break;
  }
  assert.deepEqual(changes.map((c) => `${c.kind}:${c.sequence}`), ["record:651", "record:652", "record:653", "file:654", "resource:655"]);
  const [upd, del, big, file, res] = changes;
  assert.ok(upd.kind === "record" && upd.after?.document === doc(1));
  assert.ok(del.kind === "record" && del.after === null);
  assert.ok(big.kind === "record" && big.after?.contentRef);
  assert.equal(streamed.get(653), BIG[602]);
  assert.ok(file.kind === "file" && file.after?.path === "files/a.bin");
  assert.ok(res.kind === "resource" && res.path === "_types/task.md");
  assert.deepEqual(await src.replicas(s, signal()), [{ id: rid(7001), purpose: "mirror" }]);
  const facts = await src.nextFacts(s, "journal", null, PAGE, signal());
  assert.equal(facts.rows.length, 1, "terminal facts only");
  assert.equal(facts.rows[0].state, "acknowledged");
  assert.equal(facts.rows[0].receiptDigest, "abcd");
  assert.ok(facts.done);
  assert.equal((await src.nextFacts(s, "tombstones", null, PAGE, signal())).rows.length, 0);
  await src.close(s);
});

test("keyset pages use the primary key (no per-page sort of the collection)", { skip }, async () => {
  // With the full scans disabled, an order the primary key serves needs no Sort;
  // the old `record_id::text` keyset still sorts.
  await admin.query("ANALYZE hosted_provider_records");
  await admin.query("SET enable_seqscan = off");
  await admin.query("SET enable_bitmapscan = off");
  const plan = await admin.query(
    `EXPLAIN SELECT record_id::text AS k, length(payload_ciphertext) AS ct_len FROM hosted_provider_records
     WHERE collection_id = $1::uuid AND record_id > $2::uuid ORDER BY record_id LIMIT $3`, [CID, rid(10), 251]);
  await admin.query("RESET enable_seqscan");
  await admin.query("RESET enable_bitmapscan");
  const lines = plan.rows.map((r) => String(r["QUERY PLAN"]));
  assert.ok(lines.some((l) => l.includes("hosted_provider_records_pkey")), lines.join("\n"));
  assert.ok(!lines.some((l) => /^\s*(->\s*)?Sort\b/.test(l)), lines.join("\n"));
});
