// Transport unit tests only; native authority/provider/memory gates are separate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stageSealedObject } from "../src/object-writes.ts";
import { ObjectOriginPolicy, DENY_OBJECT_ORIGINS } from "../src/object-origins.ts";
const origins = ObjectOriginPolicy.configured(["https://objects.test"]);
import { encode, decode } from "../../../packages/sdk/src/cbor.ts";

const ticket = 9, collection = new Uint8Array(16).fill(6), hash = new Uint8Array(32).fill(7);
const checksum = btoa(String.fromCharCode(...hash));
const frame = (method, params) => encode(new Map([[0, 0], [1, ticket], [2, method], [3, params]]));
const reply = (result, id = ticket) => encode(new Map([[0, 1], [1, id], [2, result]]));
const refusal = () => encode(new Map([[0, 1], [1, ticket], [3, new Map([[0, "quota_exceeded"]])]]));
const transfer = (opts = {}) => new Map([[0, opts.uri ?? "https://objects.test/sealed"],
  [1, opts.headers ?? new Map([["x-amz-checksum-sha256", checksum]])], [2, opts.expiry ?? Date.now() + 60_000]]);
function lease(size = 131_099) {
  const memory = new WebAssembly.Memory({ initial: Math.ceil(size / 65536) });
  new Uint8Array(memory.buffer, 0, size).fill(0x29);
  const seen = [];
  return { ticket, collection: collection.slice(), cipherHash: hash.slice(), sealedBytes: size,
    putFrame: frame("put_object", new Map([[0, collection], [1, hash], [2, 18], [3, size], [4, hash]])),
    commitFrame: frame("commit_object", new Map([[0, collection], [1, hash]])),
    window(off, n) { seen.push([off, n]); return new Uint8Array(memory.buffer, off, n); }, memory, seen };
}
function fixture(onPut, onCommit = () => reply(new Map([[0, true]]))) {
  const events = [], signed = [];
  return { events, signed,
    signer: { signRpc(method, key, token, body) {
      assert.equal(token, "test-only");assert.deepEqual(key, collection);
      signed.push([method, body.slice()]);return new Uint8Array(64);
    } },
    log: { async fetch(url, init) {
      if (url.endsWith("/v1/nonce")) return new Response("ab".repeat(32));
      assert.equal(init.redirect, undefined); // native PoP unary binding
      const value = decode(init.body);const method = value.get(2);events.push(method);
      assert.equal(init.headers["x-mdbase-sig"].length, 128);
      return new Response(method === "put_object" ? await onPut(init.body) : await onCommit(init.body));
    } },
  };
}
function fixed(size) {
  let count = 0;
  return new TransformStream({ transform(bytes, controller) {
    count += bytes.length;if (count > size) throw new Error("too many bytes");controller.enqueue(bytes);
  }, flush() { if (count !== size) throw new Error("too few bytes"); } });
}
async function drain(_url, init, callback = () => {}) {
  assert.equal(init.method, "PUT");assert.equal(init.redirect, "manual");
  assert.equal(init.headers.get("x-amz-checksum-sha256"), checksum);
  assert.equal(init.headers.has("authorization"), false);
  const r = init.body.getReader();let total = 0;
  try { for (;;) { const { value, done } = await r.read();if (done) break;
    assert.ok(value.length <= 64 << 10);assert.equal(value.every((b) => b === 0x29), true);
    total += value.length;await callback(value, total);
  } } finally { r.releaseLock(); }
  return new Response(null, { status: 204 });
}
const upload = (f, source, live = () => true, direct = drain, factory = fixed) =>
  stageSealedObject(f.log, f.signer, "test-only", source, live, origins, direct, factory);

test("8MiB sealed region streams fresh <=64KiB views through exact pipeline before commit", async () => {
  const source = lease((8 << 20) + 29);const f = fixture(() => reply(new Map([[0, 1], [1, transfer()]])));
  let received = 0, grown = false;
  const result = await upload(f, source, () => true, (u, init) => drain(u, init, (bytes, count) => {
    received = count;
    if (!grown) { source.memory.grow(1);grown = true;assert.equal(bytes[0], 0x29,"no detached WASM view queued"); }
  }));
  assert.equal(received, source.sealedBytes);assert.equal(source.seen.length, 129);
  assert.equal(Math.max(...source.seen.map(([, n]) => n)), 64 << 10);
  assert.deepEqual(f.events, ["put_object", "commit_object"]);
  assert.equal(decode(result.commit).get(2).get(0), true);
  assert.deepEqual(f.signed.map(([m]) => m), f.events);
  result.put.fill(0);result.commit.fill(0);
});

test("dedup and authoritative PUT quota reply return only raw metadata without touching region", async () => {
  for (const raw of [reply(new Map([[0, 2]])), refusal()]) {
    const source = lease();const f = fixture(() => raw);
    const result = await upload(f, source, () => true, () => { throw new Error("no direct upload"); });
    assert.deepEqual(result.put, raw);assert.equal(result.commit, null);
    assert.equal(source.seen.length, 0);assert.deepEqual(f.events, ["put_object"]);
    result.put.fill(0);
  }
});

test("captured descriptor and signed frames are immutable across metadata await", async () => {
  const source = lease();const original = source.putFrame.slice(), originalSize = source.sealedBytes;
  const f = fixture(() => {
    source.sealedBytes = 1;source.ticket = 99;source.putFrame.fill(0);source.commitFrame.fill(0);
    source.cipherHash.fill(0);source.collection.fill(0);
    return reply(new Map([[0, 1], [1, transfer()]]));
  });
  let count = 0;
  const result = await upload(f, source, () => true, (u, i) => drain(u, i, (_b, n) => { count = n; }));
  assert.equal(count, originalSize);assert.deepEqual(f.signed[0][1], original);
  assert.equal(decode(result.commit).get(1), ticket);
});

test("current fence fails before network or after metadata await without pulling bytes", async () => {
  const source = lease();let live = false;const f = fixture(() => { throw new Error("no RPC"); });
  await assert.rejects(upload(f, source, () => live));assert.equal(f.events.length, 0);
  live = true;const f2 = fixture(() => { live = false;return reply(new Map([[0, 1], [1, transfer()]])); });
  await assert.rejects(upload(f2, source, () => live));assert.equal(source.seen.length, 0);
  assert.deepEqual(f2.events, ["put_object"]);
});

test("signing callback cannot stale the scope before a metadata effect", async () => {
  const source = lease();let live = true;
  const f = fixture(() => { throw new Error("must not send metadata RPC"); });
  const signature = new Uint8Array(64).fill(5);
  f.signer.signRpc = () => { live = false;return signature; };
  await assert.rejects(upload(f, source, () => live));
  assert.deepEqual(f.events, []);assert.equal(source.seen.length, 0);
  assert.equal(signature.every((b) => b === 0), true);
});

test("current loss during a window pull aborts exact pipeline with no commit", async () => {
  const source = lease();let live = true;const get = source.window.bind(source);
  source.window = (o, n) => { const v = get(o, n);if (o >= 64 << 10) live = false;return v; };
  const f = fixture(() => reply(new Map([[0, 1], [1, transfer()]])));
  await assert.rejects(upload(f, source, () => live));assert.deepEqual(f.events, ["put_object"]);
  assert.equal(source.seen.length, 2);
});

test("expiry during direct upload, redirect and early rejection never reach commit", async () => {
  for (const mode of ["expire", "redirect", "reject"]) {
    const source = lease();const cap = transfer();let live = true;
    const f = fixture(() => reply(new Map([[0, 1], [1, cap]])));
    const direct = mode === "expire" ? async (u, i) => { const r = await drain(u, i);live = false;return r; }
      : async () => new Response(null, { status: mode === "redirect" ? 307 : 500 });
    await assert.rejects(upload(f, source, () => live, direct));assert.deepEqual(f.events, ["put_object"]);
  }
});

test("wrong response ID/checksum/URL/headers/expiry and oversized metadata fail without file reads", async () => {
  for (const raw of [reply(new Map([[0, 1], [1, transfer()]]), 12),
    reply(new Map([[0, 1], [1, transfer({ headers: new Map([["x-amz-checksum-sha256", "wrong"]]) })]])),
    reply(new Map([[0, 1], [1, transfer({ uri: "http://objects.test/sealed" })]])),
    reply(new Map([[0, 1], [1, transfer({ headers: new Map([["Authorization", "forbidden"]]) })]])),
    reply(new Map([[0, 1], [1, transfer({ expiry: Date.now() - 1 })]])), new Uint8Array((64 << 10) + 1)]) {
    const source = lease();const f = fixture(() => raw);
    await assert.rejects(upload(f, source));assert.equal(source.seen.length, 0);
    assert.deepEqual(f.events, ["put_object"]);
  }
});

test("native scope/bounds, unavailable stream and missing/wrong-sized views never buffer fallback", async () => {
  for (const change of [(s) => { s.sealedBytes = (9 << 20) + 1; },
    (s) => { s.putFrame = frame("put_object", new Map([[0, collection], [1, hash], [2, 18], [3, s.sealedBytes], [4, hash], [5, new Uint8Array(1)]])); },
    (s) => { s.commitFrame = frame("commit_object", new Map([[0, collection], [1, new Uint8Array(32)]])); }]) {
    const source = lease();change(source);const f = fixture(() => { throw new Error("no RPC"); });
    await assert.rejects(upload(f, source));assert.equal(f.events.length, 0);assert.equal(source.seen.length, 0);
  }
  for (const window of [() => null, () => new Uint8Array(3)]) {
    const source = lease();source.window = window;
    const f = fixture(() => reply(new Map([[0, 1], [1, transfer()]])));
    await assert.rejects(upload(f, source));assert.deepEqual(f.events, ["put_object"]);
  }
  const source = lease();const f = fixture(() => reply(new Map([[0, 1], [1, transfer()]])));
  await assert.rejects(upload(f, source, () => true, drain, () => { throw new Error("unavailable"); }));
  assert.equal(source.seen.length, 0);assert.deepEqual(f.events, ["put_object"]);
});

test("stalled consumer bounds source pulls instead of draining a sealed object", async () => {
  const source = lease((8 << 20) + 29);
  const f = fixture(() => reply(new Map([[0, 1], [1, transfer()]])));
  let release;const held = new Promise((resolve) => { release = resolve; });
  let arrived;const first = new Promise((resolve) => { arrived = resolve; });
  const pending = upload(f, source, () => true, (u, i) => drain(u, i, async (_b, n) => {
    if (n === 64 << 10) { arrived();await held; }
  }));
  await first;await new Promise((r) => setTimeout(r, 20));
  assert.ok(source.seen.length <= 3, "only bounded stream lookahead, never full object");
  assert.deepEqual(f.events, ["put_object"], "no commit before exact pipeline completes");
  release();const result = await pending;result.put.fill(0);result.commit.fill(0);
});

test("capability expires after successful PUT await: commit is not sent", async () => {
  const source = lease();const f = fixture(() => reply(new Map([[0, 1], [1, transfer({ expiry: Date.now() + 200 })]])));
  await assert.rejects(upload(f, source, () => true, async (u, i) => {
    const r = await drain(u, i);await new Promise((resolve) => setTimeout(resolve, 250));return r;
  }));
  assert.deepEqual(f.events, ["put_object"]);
});

test("known commit quota reply retained; lost commit reply does not fabricate success", async () => {
  for (const mode of ["quota", "lost"]) {
    const source = lease();const raw = refusal();
    const f = fixture(() => reply(new Map([[0, 1], [1, transfer()]])), () => {
      if (mode === "lost") throw new Error("lost reply");return raw;
    });
    if (mode === "quota") { const result = await upload(f, source);assert.deepEqual(result.commit, raw); }
    else await assert.rejects(upload(f, source));
    assert.deepEqual(f.events, ["put_object", "commit_object"]);
  }
});

test("untrusted PUT origins refuse before stream creation, region pull, network PUT or commit", async () => {
  for (const uri of ["https://unconfigured.test/sealed", "https://sub.objects.test/sealed", "https://objects.test.evil.test/sealed",
    "https://objects.test:444/sealed", "https://objects.test./sealed", "https://127.0.0.1/sealed", "https://10.0.0.1/sealed",
    "https://169.254.169.254/sealed", "https://[::1]/sealed", "https://0x7f000001/sealed", "https://log.internal/direct",
    "https://user:secret@objects.test/sealed", "https://objects.test/sealed#", "https://objects.test\\\\sealed"]) {
    const source = lease();const f = fixture(() => reply(new Map([[0, 1], [1, transfer({uri})]])));
    let streams = 0, fetches = 0;
    await assert.rejects(upload(f, source, () => true, () => {fetches++;assert.fail("no untrusted PUT");}, () => {streams++;return fixed(source.sealedBytes);}));
    assert.equal(streams, 0);assert.equal(fetches, 0);assert.equal(source.seen.length, 0);
    assert.deepEqual(f.events, ["put_object"]);
  }
});

test("missing origin authority denies direct PUT while dedup/refusal need no network destination", async () => {
  for (const raw of [reply(new Map([[0, 1], [1, transfer()]])), reply(new Map([[0, 2]])), refusal()]) {
    const source = lease();const f = fixture(() => raw);
    const run = () => stageSealedObject(f.log, f.signer, "test-only", source, () => true, DENY_OBJECT_ORIGINS,
      () => {assert.fail("no direct PUT");}, () => {assert.fail("no stream");});
    if (decode(raw).get(2)?.get(0) === 1) await assert.rejects(run());
    else {const result = await run();assert.equal(result.commit, null);result.put.fill(0);}
    assert.equal(source.seen.length, 0);assert.deepEqual(f.events, ["put_object"]);
  }
});

test("policy snapshot cannot gain PUT destinations from a mutated config during metadata await", async () => {
  const config = ["https://objects.test"], p = ObjectOriginPolicy.configured(config);
  const source = lease();const f = fixture(() => {config.push("https://new.test");return reply(new Map([[0, 1], [1, transfer({uri: "https://new.test/sealed"})]]));});
  await assert.rejects(stageSealedObject(f.log, f.signer, "test-only", source, () => true, p,
    () => {assert.fail("no direct PUT");}, () => {assert.fail("no stream");}));
  assert.equal(source.seen.length, 0);assert.deepEqual(f.events, ["put_object"]);
});
