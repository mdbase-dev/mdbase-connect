// PUBLIC synthetic source/Connect/log transport; REAL Driver, Engine, crypto,
// SQLite ledger and storage.sync. No managed credentials or authority overrides.
// Run with Node's --experimental-transform-types and explicit PUBLIC fixture/WASM.
import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { encode, decode } from "../../../packages/sdk/src/cbor.ts";

const fixture = process.env.PITR_APP_FIXTURE;
const wasmPath = process.env.HOSTED_WASM;
assert.ok(fixture && wasmPath, "explicit PUBLIC fixture and hosted WASM required");
const fixtureBytes = await readFile(fixture);
const f = JSON.parse(fixtureBytes);
const manifest = JSON.parse(await readFile(fixture.replace(/\.json$/, ".manifest.json"), "utf8"));
const bytes = s => new Uint8Array(Buffer.from(s, "hex"));
const hex = b => Buffer.from(b).toString("hex");
const uuid = b => hex(b).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
const uuidBytes = s => bytes(s.replaceAll("-", ""));
const sha = b => new Uint8Array(createHash("sha256").update(b).digest());
const hash = (tag, b) => sha(Buffer.concat([Buffer.from([Buffer.byteLength(tag)]), Buffer.from(tag), b]));
assert.equal(manifest.publicFixedTestValuesOnly, true);
assert.equal(manifest.managedCompositionQualified, false);
assert.equal(manifest.sha256, hex(sha(fixtureBytes)));
for (const [key, seed] of [["sign_sk", "43"], ["kem_sk", "44"], ["noise_sk", "47"]]) {
  assert.equal(f.hosted[key], seed.repeat(32));
}
assert.equal(f.cp_seed, "72".repeat(32));
const declared = JSON.parse(await readFile(new URL("./fixtures/public-genesis.json", import.meta.url), "utf8"));
const pins = new Uint8Array(Buffer.from(declared.pins, "base64"));
const root = decode(pins)[0][0];
assert.equal(f.root_pk, hex(root[1]));
const first = decode(bytes(f.items[0]));
const payload = decode(first.get(11));
const owner = uuid(payload.get(3).find(o => o.get(0) === 1).get(1));
const provider = "11111111-1111-4111-8111-111111111111";
const hold = "22222222-2222-4222-8222-222222222222";
const replica = "33333333-3333-4333-8333-333333333333";
const session = "44444444-4444-4444-8444-444444444444";
const stamp = "2300-01-01T00:00:00.000001Z";
const claim = {
  schema: "mdbase-migration-claim/1", collection_id: f.collection, owner_account: owner,
  started_us: "10413792000000001", target: {
    runtime: "shadow", root_key_id: hex(root[0]), hosted: {
      device_id: f.hosted.device, sign_pk: f.hosted.sign_pk,
      kem_pk: hex(payload.get(3).find(o => o.get(0) === 2 && uuid(o.get(1)) === f.hosted.device).get(5)),
      noise_pk: f.app.hosted_noise_pk,
    },
  },
};
// Explicit public fixture configuration, not text extracted from another runner.
const releaseSource = `export function appReleaseTrust() { return {
  schema: "mdbn-app-trust/release/1", environment: "lab",
  cpOrigin: "https://connect-lab.mdbase.dev", logOrigin: "https://log.test",
  trustedRoots: [Uint8Array.from(${JSON.stringify(Array.from(root[1]))})],
  policyPins: Uint8Array.from(${JSON.stringify(Array.from(pins))})
}; }`;
const source = `
import { HostedCollection } from "./src/worker.ts";
import { Engine, encode, decode } from "./src/engine.ts";
import { productionParts } from "./src/factory.ts";
import { MigrationExecutor } from "./src/migration-executor.ts";
import { storageRunStore, newRun, readNativeState } from "./src/migration-run.ts";
const f = ${JSON.stringify(f)}, claim = ${JSON.stringify(claim)};
const pins = Uint8Array.from(${JSON.stringify(Array.from(pins))});
const rootPK = Uint8Array.from(${JSON.stringify(Array.from(root[1]))});
const hold = ${JSON.stringify(hold)}, session = ${JSON.stringify(session)};
const bytes = s => Uint8Array.from(s.match(/../g) || [], v => parseInt(v, 16));
const uuid = s => bytes(s.replaceAll("-", ""));
const config = () => encode(new Map([
  [0, uuid(f.collection)], [1, uuid(f.hosted.replica)], [2, uuid(f.hosted.device)],
  [3, [rootPK]], [4, f.hosted.signers.map(uuid)], [5, bytes(f.hosted.sign_sk)],
  [6, bytes(f.hosted.kem_sk)], [8, pins], [9, bytes(f.items[0])],
  [10, bytes(${JSON.stringify(hex(sha(bytes(f.items[0]))))})]
]));
const envConfig = {
  KMS_KEY_ARN: "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111",
  AWS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "s".repeat(40),
  KMS_ENVIRONMENT: "lab", KMS_COLLECTIONS: f.collection, LOG_URL: "https://log.test",
  CP_URL: "https://connect-lab.mdbase.dev", CP_INBOUND_TOKEN: "t".repeat(40),
  HOSTED_SIGNERS: f.hosted.signers.join(",")
};
export class Probe extends HostedCollection {
  constructor(ctx, env) {
    super(ctx, env);
    this.collection = f.collection;
    const parts = productionParts(envConfig, async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/challenge")) return Response.json({ challenge: "55".repeat(32) });
      if (!path.endsWith("/read")) throw Error("unexpected CPP operation");
      const proof = JSON.parse(init.body);
      if (proof.device_id !== f.hosted.device || proof.challenge !== "55".repeat(32) ||
          !/^[0-9a-f]{128}$/.test(proof.sig)) throw Error("CPP proof fixture mismatch");
      return Response.json(this.claimDrift ? { ...claim, owner_account: hold } : claim);
    });
    if (!parts) throw Error("public factory refused");
    this.cppControl = parts.control;
    this.openNative();
  }
  async external(path, body) {
    const json = path === "connect" || path === "source";
    const response = await this.env.FIXTURES.fetch("http://fixture.test/" + path, {
      method: "POST", body: json ? JSON.stringify(body) : encode(body)
    });
    if (!response.ok) throw Error("fixture_transport:" + path);
    return json ? response.json() : decode(new Uint8Array(await response.arrayBuffer()));
  }
  openNative() {
    const e = this.engine = new Engine(this.ctx.storage);
    e.openForCppClaim(config(), this.cppControl);
    if (!e.logBind()) throw Error("log bind refused");
    return e;
  }
  async sync(e) {
    // A real ABI log push advertises the synthetic service's head. In
    // particular, CPP appends are not visible through local append replies.
    // The Engine still fetches/verifies the signed log bytes itself.
    e.ex.hd_log_push(...e.put(encode(await this.external("push", null))));
    // Tick also drives deferred install/retry work: an empty call queue is not
    // on its own evidence of completion. Match the native reference pump.
    for (let tick = 0; tick < 16; tick++) {
      e.tick(Date.now());
      for (let turn = 0; turn < 128; turn++) {
        const calls = e.logCalls();
        if (!calls.length) break;
        for (const c of calls) {
          try { e.logReply(c.id, encode(await this.external("rpc", decode(c.frame)))); }
          finally { c.frame.fill(0); }
        }
        if (turn === 127) throw Error("bounded native pump exhausted");
      }
    }
  }
  async ready() {
    const e = this.openNative();
    await this.sync(e);
    return e;
  }
  async fetch(request) {
    await this.sync(this.engine);
    const runs = storageRunStore(this.ctx.storage);
    const query = new URL(request.url).searchParams;
    const ledger = () => this.ctx.storage.sql.exec(
      "SELECT seq,kind,settled,hex(driver) AS driver,hex(action) AS action FROM mig_native_action ORDER BY seq"
    ).toArray();
    if (query.get("op") === "operator") {
      const fault = query.get("fault");
      const namespace = this.env.COLLECTIONS;
      const originalSync = this.ctx.storage.sync.bind(this.ctx.storage);
      let fired = false;
      this.claimDrift = fault === "claim";
      if (fault === "physical") this.env.COLLECTIONS = { idFromName: () => namespace.idFromName(hold) };
      if (fault === "resumeAck" || fault === "generation") Object.defineProperty(this.ctx.storage, "sync", {
        configurable: true, value: async () => {
          await originalSync();
          const run = await runs.load();
          if (!fired && (fault === "generation" || run.resumeRunSequence !== null)) {
            fired = true;
            if (fault === "generation") this.logGen++;
            else throw Error("physical_ack_lost");
          }
        }
      });
      try {
        // Real authenticated handler + owned CPP/native/sync composition.
        // Config/CPP/source transports remain PUBLIC synthetic fixture DATA.
        const response = await super.fetch(new Request("https://worker.test/v1/hosted/migration/operator?collection=" + f.collection, {
          method: "POST", headers: { authorization: "Bearer " + "public-native-token".repeat(3), "content-type": "application/json" },
          body: JSON.stringify({ collection: f.collection, operation: query.get("operation") ?? "resume", expected_run_sequence: Number(query.get("sequence")) })
        }));
        await this.ctx.storage.deleteAlarm();
        return Response.json({ status: response.status, body: await response.json() });
      } finally {
        this.claimDrift = false;
        this.env.COLLECTIONS = namespace;
        Object.defineProperty(this.ctx.storage, "sync", { configurable: true, value: originalSync });
      }
    }
    if (query.get("op") === "state") {
      const records = await Promise.all(this.ctx.storage.sql.exec("SELECT row FROM st_rec ORDER BY id").toArray().map(async row => {
        const record = decode(new Uint8Array(row.row));
        const document = new TextEncoder().encode(record[3]);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", document));
        return { path: record[1], documentBytes: document.length,
          digest: Array.from(digest, n => n.toString(16).padStart(2, "0")).join("") };
      }));
      return Response.json({ native: readNativeState(this.ctx.storage.sql), run: await runs.load(),
        admission: this.engine.admission(), ledger: ledger(), records,
        resources: this.ctx.storage.sql.exec("SELECT path,doc FROM st_res ORDER BY path").toArray(),
        receipts: this.ctx.storage.sql.exec("SELECT hex(action_id) AS action,authority_epoch,recorded_at FROM mig_rollback_receipt_data").toArray() });
    }
    if (query.get("op") === "rollback") {
      // Test operator composition: identical native CPP intent + actual sync
      // and freshness checks, with only the source transport replaced.
      const before = readNativeState(this.ctx.storage.sql);
      if (before.outstanding || ![8, 9].includes(before.checkpoint?.step)) throw Error("rollback_not_pre_cutover");
      await this.ownedMigrationClaim(request.signal, async (engine, generation, cpp, currentClaim, check) => {
        const reply = await this.external("connect", ["source", [f.collection]]);
        check();
        if (reply.status !== 200) throw Error("rollback_source_unavailable");
        engine.requestMigrationRollback(cpp, currentClaim, before.runSequence, reply.body);
        await this.ctx.storage.sync();
        check();
      });
      const run = await runs.load();
      run.state = "running"; run.reason = null;
      await runs.save(run);
      return Response.json(readNativeState(this.ctx.storage.sql));
    }
    if (!await runs.load()) await runs.save(newRun(f.collection, hold, Date.now(), query.get("pause") === "true"));
    // Override transports only. ALL prepare/seal/settle/physical-confirmation
    // operations still go through HostedCollection.migrationHost unmodified.
    const host = this.migrationHost();
    if (query.get("fault") === "gen0") {
      const method = query.get("faultKind") === "5" ? "gen0Finish" : "gen0Window";
      const seal = host[method];
      host[method] = (...args) => { seal(...args); throw Error("public_gen0_output_lost"); };
    }
    host.putObject = async (collection, object) => {
      if (collection !== f.collection) throw Error("foreign object collection");
      await this.external("put", [object.address, object.bytes]);
    };
    host.hasObjects = async (collection, addresses) => {
      if (collection !== f.collection) throw Error("foreign object collection");
      return this.external("has", addresses);
    };
    if (query.get("op") === "probe-replay") {
      const result = await host.prepare(request.signal);
      if ("ticket" in result) { host.release(result.ticket); throw Error("UNKNOWN replay admitted"); }
      return Response.json(result);
    }
    const sourcePage = async (op, id, table, selector, limits) => {
      const page = await this.external("source", { op, id, table, selector, limits });
      if (table === "resources") for (const row of page.rows) row.document = Uint8Array.from(row.document);
      return page;
    };
    const src = {
      openCheckpoint: async (req) => this.external("source", { op: "open", req }),
      nextPage: (id, table, cursor, limits) => sourcePage("page", id, table, cursor, limits),
      hydrateKeys: (id, table, keys, limits) => sourcePage("hydrate", id, table, keys, limits),
      streamRecord: async (id, ref) => {
        let offset = 0;
        return new ReadableStream({ pull: async controller => {
          const chunk = await this.external("chunk", [id, ref, offset]);
          if (chunk === null) { controller.close(); return; }
          if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > 64 * 1024)
            throw Error("invalid public stream chunk");
          offset += chunk.length;
          controller.enqueue(chunk);
        } });
      },
      close: async id => { await this.external("source", { op: "close", id }); }
    };
    const connect = new Proxy({}, { get: (_, name) => async (...args) =>
      this.external("connect", [name, args.slice(0, -1)]) });
    this.executor ??= new MigrationExecutor({ collection: f.collection, host,
      source: async () => src, connect: () => connect, store: runs, sleep: async () => {} });
    if (["resolve", "resume", "restart"].includes(query.get("op"))) {
      try {
        await this.operateMigration({ collection: f.collection, operation: query.get("op"),
          expectedSequence: Number(query.get("sequence")) }, request.signal);
        // The fixture drives continuation explicitly. Cancel only the real
        // scheduled timer so inherited production transports cannot race it.
        await this.ctx.storage.deleteAlarm();
        return Response.json({ native: readNativeState(this.ctx.storage.sql) });
      } catch (error) { return Response.json({ error: error.message, native: readNativeState(this.ctx.storage.sql) }); }
    }
    // Faults lose a platform acknowledgement AFTER the real sync completed.
    // No fabricated successful physical receipt and no native state mutation.
    const fault = query.get("fault"), faultKind = Number(query.get("faultKind") ?? 11);
    const originalSync = this.ctx.storage.sync.bind(this.ctx.storage);
    let fired = false;
    if (fault === "prepare" || fault === "settlement" || fault === "pauseAck") Object.defineProperty(this.ctx.storage, "sync", {
      configurable: true, value: async () => {
        await originalSync();
        const last = ledger().at(-1);
        const run = await runs.load();
        if (!fired && fault === "pauseAck" && run.state === "stopped" && run.reason === "operator_pause_before_cutover") {
          fired = true;
          throw Error("physical_pause_ack_lost");
        }
        if (!fired && fault !== "pauseAck" && last?.kind === faultKind && last.settled === (fault === "prepare" ? 0 : 1)) {
          fired = true;
          throw Error("physical_ack_lost");
        }
      }
    });
    try {
      return Response.json(await this.executor.wake(request.signal, {
        actions: Number(query.get("actions") ?? 64), ms: 30000
      }));
    } catch (error) {
      if (fault === "pauseAck") return Response.json({ error: error.message });
      throw error;
    } finally {
      if (fault) Object.defineProperty(this.ctx.storage, "sync", { configurable: true, value: originalSync });
    }
  }
}
export default { fetch(request, env) {
  return env.COLLECTIONS.get(env.COLLECTIONS.idFromName(f.collection)).fetch(request);
} };
`;
const compiled = await build({
  stdin: { contents: source, resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"],
  plugins: [
    { name: "owned-native-module", setup(b) {
      b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", external: true }));
    } },
    { name: "public-test-trust", setup(b) {
      b.onResolve({ filter: /^#hosted-release-trust$/ }, () => ({ path: "public", namespace: "public" }));
      b.onLoad({ filter: /.*/, namespace: "public" }, () => ({ contents: releaseSource }));
    } },
  ],
});

const cpKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), bytes(f.cp_seed)
]), format: "der", type: "pkcs8" });

const recordPrefix = "# PUBLIC synthetic record\n";
function publicService({ many = false, lostEffect = false, lostAppend = false, changedReceipt = false } = {}) {
  const items = f.items.map(bytes), objects = new Map(), effects = [], sourceCalls = [];
  const rpcCalls = [];
  const chain = () => hash("mdbase/v1/chain", items.at(-1));
  function policy(ops) {
    const p = new Map([[0, 1], [1, payload.get(1)], [2, 1700000100000 + items.length], [3, ops]]);
    const item = new Map([[0, 1], [1, 2], [2, uuidBytes(f.collection)], [3, items.length + 1],
      [4, chain()], [6, first.get(6)], [11, encode(p)]]);
    item.set(12, new Uint8Array(sign(null, hash("mdbase/v1/item-sig", encode(item)), cpKey)));
    items.push(encode(item));
  }
  function readPage(p) {
    const eligible = items.map((b, i) => [i + 1, b]).filter(([i, b]) =>
      i > p.get(1) && (p.get(3) !== 1 || [2, 3, 4, 5, 6].includes(decode(b).get(1))));
    const limit = p.get(2), budget = Math.min(p.get(4) ?? (8 << 20), 8 << 20);
    assert.ok(Number.isSafeInteger(limit) && limit > 0);
    assert.ok(Number.isSafeInteger(budget) && budget > 0);
    const rows = [];
    let used = 0;
    for (const row of eligible) {
      if (rows.length >= limit || (rows.length && used + row[1].length > budget)) break;
      rows.push(row);
      used += row[1].length;
    }
    return new Map([[0, rows], [1, items.length], [2, chain()], [3, 1], [4, false], [6, rows.length < eligible.length]]);
  }
  const ok = body => ({ status: 200, code: null, body });
  const drain = {
    collection_id: f.collection, state: "migrating", migration_id: provider,
    head: 40, started_at: stamp, retain_until: null, in_flight: 0, unresolved: 0, applied_unreceipted: 0,
  };
  const page = rows => ({ rows, next: null, done: true, collection: f.collection, S0: 40,
    holdExpiresAt: "2400-01-01T00:00:00Z" });
  const doc = new TextEncoder().encode('spec_version: "0.3.0"\n');
  const tables = {
    resources: [{ path: "mdbase.yaml", kind: "configuration",
      revision: "sha256:" + hex(sha(doc)), document: Array.from(doc) }],
    records: [], files: [],
  };
  const streams = new Map();
  if (many) {
    for (let i = 0; i < 91; i++) {
      const document = recordPrefix + "x".repeat(i === 90 ? 180_000 : 9000);
      const ref = "public-record-" + i, content = new TextEncoder().encode(document);
      const recordId = uuid(bytes((i + 1).toString(16).padStart(32, "0")));
      tables.records.push({
        recordId, path: "records/" + String(i).padStart(4, "0") + ".md",
        revision: "sha256:" + hex(sha(content)), sequence: 40, documentBytes: content.length,
        document: i === 90 ? null : document, contentRef: i === 90 ? ref : null,
      });
      if (i === 90) streams.set(ref, content);
    }
  }
  const rowKey = row => row.recordId ?? row.fileId ?? row.path;
  function sourcePage({ op, id, table, selector, limits }) {
    assert.equal(id, session);
    assert.ok(Object.hasOwn(tables, table));
    assert.ok(limits.maxRecords > 0 && limits.maxRecords <= 64);
    assert.ok(limits.maxDecodedBytes > 0 && limits.maxDecodedBytes <= (1 << 20));
    const eligible = tables[table].filter(row => op === "hydrate"
      ? selector.includes(rowKey(row)) : selector === null || rowKey(row) > selector);
    let used = 0;
    const rows = [];
    for (const row of eligible) {
      // Conservative decoded-document plus metadata charge (references do not
      // charge the document's bytes until streamed). Never overrun either bound.
      const charge = Buffer.byteLength(JSON.stringify(row));
      if (rows.length >= limits.maxRecords || used + charge > limits.maxDecodedBytes) break;
      rows.push(row);
      used += charge;
    }
    assert.ok(!eligible.length || rows.length, "public row fits page bound");
    const done = rows.length === eligible.length;
    sourceCalls.push({ op, table, count: rows.length, bytes: used, done });
    return { ...page(rows), done, next: done ? null : rowKey(rows.at(-1)) };
  }
  let receipt;
  const providerState = { fenced: false, revoked: false, route: "legacy" };
  async function fixtureService(request) {
    const path = new URL(request.url).pathname;
    const json = path === "/connect" || path === "/source";
    const body = json ? await request.json() : decode(new Uint8Array(await request.arrayBuffer()));
    let result;
    if (path === "/rpc") {
      const method = body.get(2), p = body.get(3);
      assert.deepEqual(p.get(0), uuidBytes(f.collection), "native log request is collection bound");
      rpcCalls.push(method);
      let out;
      if (method === "head") out = new Map([[0, items.length], [1, chain()], [2, 1]]);
      else if (method === "read") out = readPage(p);
      else if (method === "get_snapshot") out = new Map([[0, []]]);
      else if (method === "get_object") {
        const b = objects.get(hex(p.get(1)));
        assert.ok(b, "requested object exists");
        out = new Map([[0, b], [2, b.length], [3, sha(b)]]);
      } else if (method === "append") {
        assert.equal(p.get(1), items.length + 1);
        assert.deepEqual(p.get(2), chain());
        const start = items.length + 1;
        items.push(...p.get(3));
        out = new Map([[0, 0], [1, start], [2, items.length], [3, chain()], [4, 1700000100000]]);
        effects.push("append");
        if (lostAppend) return new Response("public append response lost", { status: 502 });
      } else throw Error("unexpected native log method:" + method);
      result = new Map([[0, 1], [1, body.get(1)], [2, out]]);
    } else if (path === "/push") {
      result = new Map([[0, 2], [1, "head"], [2, new Map([
        [0, uuidBytes(f.collection)], [1, items.length], [2, chain()]
      ])]]);
    } else if (path === "/put") {
      assert.equal(body[0], hex(sha(body[1])), "native object is content addressed");
      objects.set(body[0], body[1]);
      result = true;
    } else if (path === "/has") result = body.map(a => objects.has(a));
    else if (path === "/source") {
      if (body.op === "open") {
        assert.equal(providerState.fenced, true);
        assert.equal(body.req.collection, f.collection);
        assert.equal(body.req.S0, 40);
        assert.equal(body.req.expectedState, "migrating");
        assert.equal(body.req.backupHold, hold);
        result = { session };
      } else if (body.op === "close") {
        assert.equal(body.id, session);
        result = null;
      } else result = sourcePage(body);
    } else if (path === "/chunk") {
      assert.equal(body[0], session);
      const content = streams.get(body[1]);
      assert.ok(content, "opaque PUBLIC record reference exists");
      const offset = body[2];
      assert.ok(offset >= 0 && offset <= content.length);
      result = offset === content.length ? null : content.slice(offset, offset + 16 * 1024);
      sourceCalls.push({ op: "streamRecord", offset, bytes: result?.length ?? 0 });
    } else if (path === "/connect") {
      const [name, args] = body;
      effects.push(name);
      if (name === "account") result = ok({
        account_id: owner, backend: "legacy", cohort: "lab-run-1",
        released: true, started: true, terminal_excluded: false, paused: false,
        hosted_collections: [f.collection], unsettled_collections: [], cut_over_collections: [],
      });
      else if (name === "fence") {
        // Land the synthetic provider effect, then lose its response. This is
        // not an explicit no-outcome retry, nor a successful settlement input.
        providerState.fenced = true;
        if (lostEffect) return new Response("public effect response lost", { status: 502 });
        result = ok({ collection_id: f.collection, state: "migrating",
          migration_id: provider, started_at: stamp, retain_until: null, restored: [] });
      } else if (name === "source") {
        assert.equal(providerState.fenced, true);
        result = ok(drain);
      } else if (name === "replicas") result = ok({ replicas: [{ id: replica, head: 40,
        acknowledged_sequence: 40, last_seen_at: stamp, token_expires_at: stamp }] });
      else if (name === "revoke") {
        providerState.revoked = true;
        result = ok({ revoked: [replica] });
      } else if (name === "membersPolicy") result = ok({ queued: 0 });
      else if (name === "cutoverPolicy") {
        assert.equal(providerState.revoked, true);
        policy([new Map([[0, 10], [1, uuidBytes(f.collection)], [2, [uuidBytes(replica)]], [3, 1700000100000]]),
          new Map([[0, 11], [1, false]])]);
        result = ok({ created: true });
      } else if (name === "cutover") {
        providerState.route = "hosted";
        result = ok({ collection_id: f.collection, account_id: owner });
      } else if (name === "rollback") {
        const scope = args[2];
        assert.equal(scope.original, false);
        assert.equal(scope.providerMigrationId, provider);
        assert.equal(scope.fixedHead, 40);
        assert.deepEqual(scope.replicaIds, providerState.revoked ? [replica] : [], "restore exactly the actually revoked set");
        assert.equal(receipt, undefined, "provider restore is never replayed");
        receipt = {
          collection_id: f.collection, binding: {
            owner_account_id: owner, provider_migration_id: provider, authority_epoch: 17,
            fixed_head: scope.fixedHead, driver_id: scope.driverId, action_id: scope.actionId,
            replica_ids: scope.replicaIds,
          }, restored_ids: scope.replicaIds.slice(), recorded_at: "2026-10-12T22:00:00Z",
        };
        providerState.fenced = false;
        providerState.revoked = false;
        result = ok(receipt);
      } else if (name === "rollbackReceipt") {
        const scope = args[2];
        assert.ok(receipt);
        assert.equal(scope.original, true);
        assert.equal(scope.driverId, receipt.binding.driver_id);
        assert.equal(scope.actionId, receipt.binding.action_id, "lookup retains ORIGINAL action");
        assert.equal(scope.authorityEpoch, receipt.binding.authority_epoch);
        assert.deepEqual(scope.replicaIds, receipt.binding.replica_ids);
        result = ok(changedReceipt ? { ...receipt, recorded_at: "2026-10-12T22:01:00Z" } : receipt);
      } else throw Error("unexpected Connect:" + name);
    } else throw Error("unexpected fixture route:" + path);
    return json ? Response.json(result) : new Response(encode(result));
  }
  const expectedRecords = tables.records.map(row => ({ path: row.path,
    documentBytes: row.documentBytes, digest: row.revision.slice("sha256:".length) }));
  return { fixtureService, effects, sourceCalls, rpcCalls, providerState, items, objects, expectedRecords,
    receipt: () => receipt, readPage };
}

await mkdir(new URL("../.test-state/", import.meta.url), { recursive: true });
const wasm = await readFile(wasmPath);
async function scenario(name, config, qualify) {
  const service = publicService(config);
  const scratch = await mkdtemp(fileURLToPath(new URL("../.test-state/native-executor-", import.meta.url)));
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const options = () => convertV4MiniflareOptions({
    name: "real-native-executor", modules: [
      { type: "ESModule", path: "worker.js", contents: compiled.outputFiles[0].text },
      { type: "CompiledWasm", path: "hosted.wasm", contents: wasm }
    ], compatibilityDate: "2026-10-05", port: 0,
    bindings: { CP_URL: "https://connect-lab.mdbase.dev", CP_MIGRATION_TOKEN: "public-native-token".repeat(3),
      HOSTED_SERVICE_TOKEN: "public-native-token".repeat(3) },
    durableObjects: { COLLECTIONS: { className: "Probe", useSQLite: true } },
    serviceBindings: { FIXTURES: service.fixtureService },
    // No external calls: exercise the production operator's real Connect client
    // against only the synthetic source endpoint; refuse every other outbound.
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.hostname, "connect-lab.mdbase.dev");
      assert.equal(url.pathname, "/internal/v1/next/migration/collections/" + f.collection + "/source");
      const reply = await service.fixtureService(new Request("http://fixture.test/connect", {
        method: "POST", body: JSON.stringify(["source", [f.collection]])
      })).then(r => r.json());
      return Response.json(reply.body, { status: reply.status });
    },
    resourcePersistencePath: scratch, resourceTmpPath: scratch
  });
  let mf, passed = false;
  const call = async (query = {}) => {
    const response = await mf.dispatchFetch("http://fixture.test/?" + new URLSearchParams(query));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const reopen = async () => {
    await mf?.dispose();
    mf = new Miniflare(options());
  };
  try {
    await reopen();
    await qualify({ call, state: () => call({ op: "state" }), reopen, service });
    passed = true;
    console.log("PASS", name);
  } catch (error) {
    console.error("FAILED", name, error);
    try { console.error(JSON.stringify(await call({ op: "state" }))); } catch {}
    throw error;
  } finally {
    await mf?.dispose();
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    if (passed) await rm(scratch, { recursive: true });
    else console.error("Retained isolated native executor evidence", scratch);
  }
}
async function cutover({ call, state, reopen, service }) {
  // Service-contract regression: count bound and soft byte bound, with the
  // first oversized eligible item still returned to permit forward progress.
  const bounded = service.readPage(new Map([[1, 0], [2, 1], [4, 1]]));
  assert.equal(bounded.get(0).length, 1);
  assert.equal(bounded.get(6), true);
  const next = service.readPage(new Map([[1, 1], [2, 64], [4, 1]]));
  assert.equal(next.get(0)[0][0], 2);
  assert.equal(next.get(6), service.items.length > 2);
  let result;
  for (let wake = 0; wake < 40; wake++) {
    result = await call();
    if (result.state === "done") break;
    assert.notEqual(result.state, "stopped", result.reason);
  }
  assert.equal(result.state, "done", "actual native cutover completes");
  const final = await state();
  assert.equal(final.native.checkpoint.step, 13);
  assert.equal(final.native.outstanding, null);
  assert.ok(final.ledger.every(row => row.settled === 1));
  assert.equal(service.effects.filter(e => e === "append").length, 1);
  assert.equal(service.effects.filter(e => e === "cutoverPolicy").length, 1);
  assert.equal(service.effects.filter(e => e === "cutover").length, 1);
  assert.ok(service.objects.size > 0, "native gen0 objects actually stored and reinstalled");
  // A fully retained log need not request snapshots. Independently check the
  // synthetic transport's required empty field, without feeding it as proof.
  const snapshots = await service.fixtureService(new Request("http://fixture.test/rpc", {
    method: "POST", body: encode(new Map([[0, 0], [1, 9999], [2, "get_snapshot"],
      [3, new Map([[0, uuidBytes(f.collection)]])]]))
  }));
  assert.deepEqual(decode(new Uint8Array(await snapshots.arrayBuffer())).get(2).get(0), []);
  assert.ok(service.rpcCalls.includes("get_object"), "native installed base from actual uploaded objects");
  assert.deepEqual(final.records, service.expectedRecords, "SQLite holds every exact original document digest and byte count");
  assert.deepEqual(final.resources, [{ path: "mdbase.yaml", doc: 'spec_version: "0.3.0"\n' }]);
  assert.equal(service.providerState.route, "hosted");
  await reopen();
  const reopened = await state();
  assert.deepEqual(reopened.native, final.native);
  assert.deepEqual(reopened.ledger, final.ledger);
  assert.deepEqual(reopened.records, final.records);
  assert.deepEqual(reopened.resources, final.resources);
  assert.equal((await call()).state, "done");
  return final;
}
async function reachPause(ctx) {
  let result;
  for (let wake = 0; wake < 40; wake++) {
    result = await ctx.call({ pause: true });
    if (result.state === "stopped") break;
  }
  assert.equal(result.reason, "operator_pause_before_cutover");
  const before = await ctx.state();
  assert.equal(before.native.checkpoint.step, 8);
  assert.equal(before.native.outstanding, null);
  assert.equal(before.run.pauseBeforeCutover, true);
  assert.equal(before.run.resumeRunSequence, null);
  assert.ok(!before.ledger.some(row => [14, 15, 16, 17, 18, 19].includes(row.kind)), "no revoke/cutover preparation");
  assert.ok(!ctx.service.effects.includes("cutoverPolicy"));
  return before;
}
await scenario("verified native H1 pause persists; stale/duplicate resume refuse; exact resume cuts over", {}, async ctx => {
  const before = await reachPause(ctx);
  await ctx.reopen();
  assert.deepEqual((await ctx.state()).native, before.native);
  assert.equal((await ctx.call()).reason, "operator_pause_before_cutover");
  const stale = await ctx.call({ op: "resume", sequence: before.native.runSequence + 1 });
  assert.equal(stale.error, "migration_operator_conflict");
  assert.deepEqual((await ctx.state()).ledger, before.ledger);
  const resumed = await ctx.call({ op: "resume", sequence: before.native.runSequence });
  assert.equal(resumed.error, undefined);
  assert.equal((await ctx.state()).run.resumeRunSequence, before.native.runSequence);
  assert.equal((await ctx.call({ op: "resume", sequence: before.native.runSequence })).error, "migration_operator_busy");
  await cutover(ctx);
});
await scenario("verified H1 pause routes back with original receipt, then fresh run preserves requested pause", {}, async ctx => {
  const before = await reachPause(ctx);
  const intent = await ctx.call({ op: "rollback" });
  assert.equal(intent.checkpoint.step, 20);
  assert.equal((await ctx.call()).reason, "terminal:21");
  const rolledBack = await ctx.state();
  assert.equal(rolledBack.native.checkpoint.fenced, false);
  assert.equal(rolledBack.native.outstanding, null);
  assert.equal(ctx.service.providerState.route, "legacy");
  await ctx.reopen();
  const restarted = await ctx.call({ op: "restart", sequence: before.native.runSequence });
  assert.equal(restarted.error, undefined);
  assert.equal(restarted.native.runSequence, before.native.runSequence + 1);
  const fresh = await ctx.state();
  assert.equal(fresh.run.pauseBeforeCutover, true);
  assert.equal(fresh.run.resumeRunSequence, null);
});
await scenario("authenticated concurrent resume has one continuation; busy refusal does not stop it", {}, async ctx => {
  const before = await reachPause(ctx);
  const replies = await Promise.all([ctx.call({ op: "operator", sequence: before.native.runSequence }),
    ctx.call({ op: "operator", sequence: before.native.runSequence })]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.equal(replies.find(r => r.status === 409).body.error, "migration_operator_busy");
  assert.equal((await ctx.state()).run.state, "running", "pure busy refusal must not turn successful continuation UNKNOWN");
  await cutover(ctx);
});
for (const fault of ["physical", "claim", "generation"]) {
  await scenario("authenticated resume refuses " + fault + " drift before arming continuation", {}, async ctx => {
    const before = await reachPause(ctx);
    const reply = await ctx.call({ op: "operator", sequence: before.native.runSequence, fault });
    assert.equal(reply.status, 409);
    const after = await ctx.state();
    assert.equal(after.run.state, "stopped");
    assert.equal(after.run.resumeRunSequence, null);
    assert.deepEqual(after.ledger, before.ledger);
    await ctx.reopen();
    assert.equal((await ctx.call()).reason, "operator_pause_before_cutover");
    assert.ok(!ctx.service.effects.includes("cutoverPolicy"));
  });
}
await scenario("resume lost physical ACK keeps consumed intent UNKNOWN across reopen; never retries", {}, async ctx => {
  const before = await reachPause(ctx);
  const reply = await ctx.call({ op: "operator", sequence: before.native.runSequence, fault: "resumeAck" });
  assert.equal(reply.status, 409);
  assert.equal(reply.body.error, "physical_ack_lost");
  const after = await ctx.state();
  assert.equal(after.run.state, "stopped");
  assert.equal(after.run.reason, "operator_outcome_unknown");
  assert.equal(after.run.resumeRunSequence, before.native.runSequence);
  assert.deepEqual(after.ledger, before.ledger);
  await ctx.reopen();
  assert.equal((await ctx.call()).reason, "operator_outcome_unknown");
  assert.equal((await ctx.call({ op: "operator", sequence: before.native.runSequence })).status, 409);
  assert.ok(!ctx.service.effects.includes("cutoverPolicy"));
});
await scenario("lost physical pause ACK persists stopped H1 across reopen without preparation/replay", {}, async ctx => {
  let result;
  for (let wake = 0; wake < 40; wake++) {
    result = await ctx.call({ pause: true, fault: "pauseAck" });
    if (result.error || result.state === "stopped") break;
  }
  assert.equal(result.error, "physical_pause_ack_lost");
  const before = await ctx.state();
  assert.equal(before.native.checkpoint.step, 8);
  assert.equal(before.native.outstanding, null);
  assert.equal(before.run.reason, "operator_pause_before_cutover");
  await ctx.reopen();
  assert.equal((await ctx.call()).reason, "operator_pause_before_cutover");
  assert.deepEqual((await ctx.state()).ledger, before.ledger);
  assert.ok(!ctx.service.effects.includes("cutoverPolicy"));
});
for (const kind of [4, 5]) {
  await scenario("fenced staged gen0 kind " + kind + " authenticated rollback survives reopen", {}, async ctx => {
    const stopped = await ctx.call({ fault: "gen0", faultKind: kind });
    assert.match(stopped.reason, /^gen0_window_unknown:/);
    const before = await ctx.state();
    assert.equal(before.native.checkpoint.step, 2);
    assert.equal(before.native.checkpoint.fenced, true);
    assert.equal(before.native.outstanding.kind, kind);
    assert.equal(ctx.service.providerState.fenced, true);
    await ctx.reopen();
    const stale = await ctx.call({ op: "operator", operation: "rollback", sequence: before.native.runSequence + 1 });
    assert.equal(stale.status, 409);
    assert.equal((await ctx.state()).native.outstanding.kind, kind);
    const rolled = await ctx.call({ op: "operator", operation: "rollback", sequence: before.native.runSequence });
    assert.equal(rolled.status, 200, JSON.stringify(rolled));
    await ctx.reopen();
    assert.equal((await ctx.state()).native.outstanding, null);
    await ctx.call();
    const terminal = await ctx.state();
    assert.equal(terminal.native.checkpoint.step, 21);
    assert.equal(terminal.native.checkpoint.fenced, false);
    assert.equal(ctx.service.providerState.fenced, false);
    assert.ok(terminal.ledger.every(row => row.settled === 1));
    assert.equal(ctx.service.effects.filter(e => e === "rollback").length, 1);
    assert.equal(ctx.service.effects.includes("append"), false);
    assert.equal(ctx.service.effects.includes("cutover"), false);
    const restarted = await ctx.call({ op: "restart", sequence: before.native.runSequence });
    assert.equal(restarted.native.runSequence, before.native.runSequence + 1);
    assert.equal(restarted.native.checkpoint.step, 0);
  });
}

await scenario("small signed-policy native cutover + persistent reopen", {}, cutover);
await scenario("gen0 multi-window, paged hydration and streamRecord native cutover", { many: true }, async ctx => {
  const final = await cutover(ctx);
  const windows = final.ledger.filter(row => row.kind === 4).length;
  assert.ok(windows > 2, "more than the small fixture's two windows actually settled");
  const calls = ctx.service.sourceCalls;
  assert.ok(calls.some(c => c.op === "page" && !c.done), "source cursor continuation exercised");
  const stream = calls.filter(c => c.op === "streamRecord");
  assert.ok(stream.length > 2 && stream.at(-1).bytes === 0, "bounded record stream consumed through EOF");
  const streamedBytes = stream.reduce((n, c) => n + c.bytes, 0);
  assert.equal(streamedBytes, 180_000 + Buffer.byteLength(recordPrefix));
  console.log("gen0 proof", { records: final.records.length, windows,
    hydrationPages: calls.filter(c => c.op === "hydrate").length,
    streamChunks: stream.length - 1, streamedBytes });
});

async function reachRevoked({ call, state }) {
  for (let wake = 0; wake < 150; wake++) {
    const result = await call({ actions: 1 });
    assert.notEqual(result.state, "stopped", result.reason);
    const current = await state();
    if (current.native.checkpoint?.step === 9 && !current.native.outstanding) return current;
  }
  assert.fail("native pre-cutover Revoked boundary not reached");
}
async function rollback(ctx, changed = false) {
  const before = await reachRevoked(ctx);
  assert.deepEqual(before.native.checkpoint.revoked, [replica]);
  assert.ok(!ctx.service.effects.includes("cutoverPolicy"));
  const intent = await ctx.call({ op: "rollback" });
  assert.equal(intent.checkpoint.step, 20);
  assert.equal((await ctx.call({ actions: 1 })).state, "running");
  const unrevoke = await ctx.state();
  assert.equal(unrevoke.native.checkpoint.step, 20);
  assert.equal(unrevoke.native.checkpoint.fenced, true);
  assert.deepEqual(unrevoke.native.checkpoint.revoked, []);
  assert.equal(unrevoke.receipts.length, 1);
  const original = ctx.service.receipt();
  assert.equal(unrevoke.receipts[0].action.toLowerCase(), original.binding.action_id.replaceAll("-", ""));
  await ctx.reopen();
  assert.deepEqual((await ctx.state()).receipts, unrevoke.receipts);
  const result = await ctx.call();
  const final = await ctx.state();
  const actions = final.ledger.filter(r => [20, 21].includes(r.kind));
  assert.equal(actions.length, 2);
  assert.notEqual(actions[0].action, actions[1].action, "Unfence has its OWN different pending action");
  assert.deepEqual(final.receipts, unrevoke.receipts, "ORIGINAL receipt is never refreshed");
  assert.equal(ctx.service.effects.filter(e => e === "rollback").length, 1);
  assert.equal(ctx.service.effects.filter(e => e === "rollbackReceipt").length, 1);
  assert.ok(!ctx.service.effects.includes("cutover"));
  assert.deepEqual(ctx.service.providerState, { fenced: false, revoked: false, route: "legacy" });
  if (changed) {
    // Even though the provider is already active/restored, that state cannot
    // substitute for the exact ORIGINAL receipt when native clears its fence.
    assert.equal(result.reason, "settlement_refused:21");
    assert.equal(final.native.checkpoint.fenced, true);
    assert.equal(final.native.checkpoint.step, 20);
    assert.equal(final.native.outstanding.kind, 21);
    await ctx.reopen();
    assert.deepEqual((await ctx.state()).native, final.native);
    assert.equal((await ctx.call({ op: "probe-replay" })).idle, 7);
  } else {
    assert.equal(result.reason, "terminal:21");
    assert.equal(final.native.checkpoint.step, 21);
    assert.equal(final.native.checkpoint.fenced, false);
    assert.equal(final.native.outstanding, null);
    assert.ok(actions.every(row => row.settled === 1));
    await ctx.reopen();
    assert.deepEqual((await ctx.state()).native, final.native);
  }
}
await scenario("pre-cutover original-receipt-qualified route-back across reopen", {}, ctx => rollback(ctx));
await scenario("changed ORIGINAL receipt refuses Unfence and preserves UNKNOWN", { changedReceipt: true }, ctx => rollback(ctx, true));

// Deterministic lost-output fault injection, then disposal/reopen of real
// persistent workerd. This qualifies eviction/UNKNOWN, not SIGKILL or disk loss.
for (const kind of [11, 6]) for (const fault of ["prepare", "effect", "settlement"]) {
  const effect = kind === 11 ? "fence" : "append";
  await scenario(effect + " lost " + fault + " boundary: UNKNOWN + persistent reopen forbids replay",
    { lostEffect: kind === 11 && fault === "effect", lostAppend: kind === 6 && fault === "effect" }, async ctx => {
      const result = await ctx.call({ fault, faultKind: kind });
      assert.equal(result.state, "stopped");
      assert.equal(result.reason, fault === "prepare" ? "outstanding_unknown" :
        fault === "effect" ? (kind === 11 ? "effect_unknown:11" : "executor_error:fixture_transport:rpc") :
          "settlement_unknown");
      const before = await ctx.state();
      const last = before.ledger.at(-1);
      assert.equal(last.kind, kind);
      assert.equal(last.settled, fault === "settlement" ? 1 : 0);
      assert.equal(ctx.service.effects.filter(e => e === effect).length, fault === "prepare" ? 0 : 1);
      const effects = [...ctx.service.effects];
      await ctx.reopen();
      const after = await ctx.state();
      assert.deepEqual(after.ledger, before.ledger, "exact original driver/action identity survives");
      assert.deepEqual(after.native, before.native);
      assert.deepEqual(after.run, before.run, "lost settlement output remains operator-stopped UNKNOWN");
      for (let i = 0; i < 3; i++) assert.deepEqual(await ctx.call(), result);
      if (fault !== "settlement") assert.equal((await ctx.call({ op: "probe-replay" })).idle, 7);
      assert.deepEqual((await ctx.state()).ledger, before.ledger);
      assert.deepEqual(ctx.service.effects, effects, "no effect replay after eviction");
    });
}
await scenario("accepted Base resolves from real log proof after eviction, then resumes to cutover",
  { lostAppend: true }, async ctx => {
    const lost = await ctx.call();
    assert.equal(lost.reason, "executor_error:fixture_transport:rpc");
    const before = await ctx.state();
    assert.equal(before.native.outstanding.kind, 6);
    await ctx.reopen();
    const resolved = await ctx.call({ op: "resolve", sequence: before.native.outstanding.sequence });
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.native.outstanding, null);
    assert.equal(ctx.service.effects.filter(e => e === "append").length, 1);
    await cutover(ctx);
  });
await scenario("unaccepted Base cannot resolve from absence after eviction", {}, async ctx => {
  await ctx.call({ fault: "prepare", faultKind: 6 });
  const before = await ctx.state();
  await ctx.reopen();
  const resolved = await ctx.call({ op: "resolve", sequence: before.native.outstanding.sequence });
  assert.equal(resolved.error, "migration_resolution_unknown");
  assert.deepEqual(resolved.native, before.native);
  assert.equal(ctx.service.effects.filter(e => e === "append").length, 0);
  assert.equal((await ctx.call({ op: "probe-replay" })).idle, 7);
});
console.log("PUBLIC qualification only; no managed-release/provider qualification; WASM SHA256=" + hex(sha(wasm)));
