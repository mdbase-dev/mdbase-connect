// Integration RED is the retained shipped-pump workerd run. These unit tests
// exercise production transport boundaries with spies; native validation remains
// covered by the actual-engine workerd run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decode, encode } from "../../../packages/sdk/src/cbor.ts";
import { pumpLog, sendCall, StaleAppendStore } from "../src/log.ts";
import { fetchAttachment } from "../src/object-reads.ts";
import { streamDirectObject } from "../src/object-download.ts";
import { ObjectOriginPolicy, DENY_OBJECT_ORIGINS } from "../src/object-origins.ts";

const sha = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const origins = ObjectOriginPolicy.configured(["https://objects.test"], true);
function canonical(value) {
  if (value instanceof Map) {
    const entries = [...value].map(([k, v]) => [k, canonical(v)]);
    if (entries.every(([k]) => typeof k === "number")) entries.sort(([a], [b]) => a - b);
    return new Map(entries);
  }
  if (Array.isArray(value)) return value.map(canonical);
  return value;
}
function byteBody(data, facts, onPull = () => {}) {
  let offset = 0;
  return new ReadableStream({
    type: "bytes",
    pull(controller) {
      onPull(offset);
      const request = controller.byobRequest;
      assert.ok(request, "Direct always uses BYOB");
      facts.windows.push(request.view.byteLength);
      if (offset === data.length) { controller.close(); request.respond(0); return; }
      const n = Math.min(request.view.byteLength, data.length - offset);
      new Uint8Array(request.view.buffer, request.view.byteOffset, n).set(data.subarray(offset, offset + n));
      offset += n;
      request.respond(n);
    },
    cancel() { facts.cancelled++; },
  });
}
function fixture(data = new Uint8Array((1 << 20) + 17).fill(9), options = {}) {
  const id = 3, checksum = sha(data);
  const params = new Map([[0, new Uint8Array(16).fill(4)], [1, new Uint8Array(32).fill(5)]]);
  if (options.range !== undefined) params.set(2, options.range);
  const frame = encode(new Map([[0, 0], [1, id], [2, "get_object"], [3, params]]));
  const transfer = new Map([[0, options.uri ?? "https://log.internal/direct"], [1, new Map()], [2, Date.now() + 60_000]]);
  const result = new Map([[1, transfer], [2, data.length], [3, checksum], [10, "future-result-field"]]);
  const response = new Map([[0, 1], [1, id], [2, result], [11, "future-response-field"]]);
  const facts = { gets: 0, rpc: 0, cancelled: 0, windows: [], failures: [], replies: [], live: true };
  const headers = new Headers({ "content-length": String(data.length),
    "content-range": `bytes 0-${data.length - 1}/${data.length}`,
    "x-amz-checksum-sha256": Buffer.from(checksum).toString("base64") });
  const f = { id, data, frame, checksum, transfer, result, response, headers, facts, onPull: () => {},
    onGet: null, onReply: null, onRpc: () => {} };
  const get = async (url, init) => {
    facts.gets++;
    assert.equal(url, transfer.get(0));
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, undefined, "Worker fetch has no ambient cookie jar/credentials option");
    const h = new Headers(init.headers);
    assert.equal(h.get("range"), `bytes=0-${data.length - 1}`);
    assert.equal(h.get("authorization"), null);
    assert.equal(h.get("cookie"), null);
    if (f.onGet) return f.onGet(url, init);
    return new Response(byteBody(f.body ?? data, facts, offset => f.onPull(offset)), { status: 206, headers });
  };
  f.log = { fetch: async (url, init) => {
    if (url.endsWith("/nonce")) return new Response("ab".repeat(32));
    if (url.endsWith("/rpc")) {
      facts.rpc++; f.onRpc();
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-token");
      return new Response(encode(canonical(response)));
    }
    return get(url, init);
  } };
  f.get = get;
  f.engine = {
    logBound: true, logCalls: () => facts.rpc ? [] : [{ id, frame }],
    signRpc: () => new Uint8Array(64),
    logReply: (replyId, bytes) => { facts.replies.push([replyId, bytes.slice()]); facts.replyRef = bytes; f.onReply?.(bytes); },
    logFailed: failedId => facts.failures.push(failedId),
  };
  f.send = (policy = origins) => sendCall(f.log, f.engine, "test-token", { id, frame }, () => facts.live,
    new StaleAppendStore(), undefined, undefined, policy);
  return f;
}

test("normal pump completes >1MiB Direct, keeps canonical unknown fields, wipes its delivered bytes", async () => {
  const f = fixture();
  await pumpLog(f.log, f.engine, async () => "test-token", () => f.facts.live,
    new StaleAppendStore(), 2, undefined, undefined, undefined, { objectOrigins: origins });
  assert.equal(f.facts.gets, 1);
  assert.deepEqual(f.facts.failures, []);
  assert.equal(f.facts.replies.length, 1);
  const [id, bytes] = f.facts.replies[0], res = decode(bytes), result = res.get(2);
  assert.equal(id, f.id);
  assert.equal(res.get(0), 1); assert.equal(res.get(1), f.id);
  assert.equal(res.get(11), "future-response-field");
  assert.equal(result.get(10), "future-result-field");
  assert.equal(result.has(1), false);
  assert.deepEqual(result.get(0), f.data);
  assert.deepEqual(result.get(3), f.checksum);
  assert.deepEqual([...result.keys()], [0, 2, 3, 10]);
  assert.deepEqual(encode(res), bytes, "normalized internal reply remains canonical");
  assert.ok(f.facts.replyRef.every(b => b === 0));
  assert.ok(f.facts.windows.length > 16);
  assert.ok(f.facts.windows.every(n => n === 64 << 10), "same-size BYOB backing store reused through EOF");
});

test("normal pump turns Direct completion errors into retryable failures and continues the queued retry", async () => {
  for (const failure of ["expired capability", "refused partial range"]) {
    const f = fixture(new Uint8Array(256).fill(9));
    const params = decode(f.frame).get(3);
    const retryFrame = range => encode(new Map([[0, 0], [1, f.id], [2, "get_object"], [3, new Map([...params, ...(range ? [[2, range]] : [])])]]));
    f.engine.logCalls = () => f.facts.rpc < 2 ? [{ id: f.id,
      frame: retryFrame(failure === "refused partial range" && f.facts.rpc === 0 ? [1, 10] : null) }] : [];
    f.onRpc = () => f.transfer.set(2, f.facts.rpc === 1 && failure === "expired capability" ? Date.now() - 1 : Date.now() + 60_000);
    const report = { work: 0, reads: 0, failed: 0, exhausted: false };
    await pumpLog(f.log, f.engine, async () => "test-token", () => true,
      new StaleAppendStore(), 3, undefined, undefined, undefined, { objectOrigins: origins, report });
    assert.deepEqual(f.facts.failures, [f.id], failure);
    assert.equal(report.failed, 1, "exception becomes one retryable call failure, not a pump throw");
    assert.equal(f.facts.rpc, 2, "the pump continues and drains the queued retry");
    assert.equal(f.facts.gets, 1); assert.equal(f.facts.replies.length, 1);
    assert.deepEqual(decode(f.facts.replies[0][1]).get(2).get(0), f.data);
  }
});

test("existing 9MiB bound is inclusive, never enlarged", async () => {
  const f = fixture(new Uint8Array(9 << 20).fill(9));
  assert.equal(await f.send(), "sent");
  assert.equal(decode(f.facts.replies[0][1]).get(2).get(0).length, 9 << 20);
});

test("a refused pinned write wipes the returned piece and cancels, without completion", async () => {
  const f = fixture(new Uint8Array(128 << 10).fill(9));
  let piece;
  await assert.rejects(streamDirectObject(f.log, f.transfer, f.data.length, f.checksum, () => true, origins,
    () => true, bytes => { piece = bytes; return false; }));
  assert.equal(f.facts.cancelled, 1);
  assert.equal(piece.length, 64 << 10);
  assert.ok(piece.every(b => b === 0), ".fill(0), not just releaseLock");
});

test("Direct is opt-in: raw metadata sendCall remains capped and never fetches a body", async () => {
  const f = fixture();
  await sendCall(f.log, f.engine, "test-token", { id: f.id, frame: f.frame }, () => true,
    new StaleAppendStore(0, 0), undefined, (1 << 20) + (32 << 10));
  assert.equal(f.facts.gets, 0);
  assert.equal(decode(f.facts.replies[0][1]).get(2).has(1), true);
  const g = fixture(); g.response.set(12, new Uint8Array((1 << 20) + (32 << 10)));
  await sendCall(g.log, g.engine, "test-token", { id: g.id, frame: g.frame }, () => true,
    new StaleAppendStore(0, 0), undefined, (1 << 20) + (32 << 10));
  assert.equal(g.facts.gets, 0); assert.deepEqual(g.facts.failures, [g.id]);
});

test("invalid Direct metadata fails before allocation/fetch and never reaches logReply", async () => {
  const cases = [
    f => f.result.set(2, (9 << 20) + 1), f => f.result.set(2, 0), f => f.result.set(2, 1.5),
    f => f.result.set(3, new Uint8Array(31)), f => f.result.set(0, new Uint8Array(1)),
    f => f.response.set(0, 0), f => f.response.set(1, f.id + 1), f => f.response.set(3, new Map()),
    f => f.transfer.set(2, Date.now() - 1), f => f.transfer.set(2, 1.5),
    f => f.transfer.set(1, new Map([["Authorization", "no"]])),
    f => f.transfer.set(1, new Map([["Cookie", "no"]])),
    f => f.transfer.set(1, new Map([["Range", "bytes=0-1"]])),
    f => f.transfer.set(1, new Map(Array.from({ length: 33 }, (_, i) => [`x-${i}`, "v"]))),
    f => f.transfer.set(1, new Map([["x-a", "x".repeat(4097)]])),
    f => f.transfer.set(1, new Map(Array.from({ length: 5 }, (_, i) => [`x-${i}`, "x".repeat(4096)]))),
  ];
  for (const mutate of cases) {
    const f = fixture(new Uint8Array(256).fill(9)); mutate(f);
    assert.equal(await f.send(), "failed");
    assert.equal(f.facts.gets, 0); assert.equal(f.facts.replies.length, 0);
    assert.deepEqual(f.facts.failures, [f.id]);
  }
});

test("missing authority, unsafe origins and URL credentials cannot become outbound GETs", async () => {
  for (const uri of ["https://evil.test/x", "https://objects.test.evil.test/x", "https://sub.objects.test/x",
    "https://objects.test:444/x", "https://user:password@objects.test/x", "https://127.0.0.1/x",
    "https://169.254.169.254/x", "http://objects.test/x", "https://objects.test/x#fragment"]) {
    const f = fixture(new Uint8Array(256), { uri });
    assert.equal(await f.send(), "failed"); assert.equal(f.facts.gets, 0);
  }
  const f = fixture(); assert.equal(await f.send(DENY_OBJECT_ORIGINS), "failed");
  assert.equal(f.facts.gets, 0);
});

test("approved provider uses ordinary fetch without credentials, not the log binding", async t => {
  const f = fixture(new Uint8Array(256), { uri: "https://objects.test/object" });
  t.mock.method(globalThis, "fetch", f.get);
  assert.equal(await f.send(), "sent"); assert.equal(f.facts.gets, 1);
});

test("Direct enforces exact status/length/range/hash headers, cancels rejected bodies", async () => {
  for (const change of [
    h => h.set("content-length", "255"), h => h.delete("content-length"),
    h => h.set("content-range", "bytes 0-254/256"), h => h.delete("content-range"),
    h => h.set("x-amz-checksum-sha256", "wrong"), h => h.delete("x-amz-checksum-sha256"),
    h => h.set("content-encoding", "gzip"),
  ]) {
    const f = fixture(new Uint8Array(256)); change(f.headers);
    assert.equal(await f.send(), "failed");
    assert.equal(f.facts.cancelled, 1); assert.equal(f.facts.windows.length, 0);
    assert.equal(f.facts.replies.length, 0);
  }
  for (const status of [200, 302, 307, 403]) {
    const f = fixture(new Uint8Array(256));
    f.onGet = () => new Response(byteBody(f.data, f.facts), { status, headers: f.headers });
    assert.equal(await f.send(), "failed"); assert.equal(f.facts.cancelled, 1);
    assert.equal(f.facts.replies.length, 0);
  }
});

test("short, oversized and non-BYOB bodies fail closed", async () => {
  for (const count of [255, 257]) {
    const f = fixture(new Uint8Array(256)); f.body = new Uint8Array(count);
    assert.equal(await f.send(), "failed"); assert.equal(f.facts.replies.length, 0);
    if (count > 256) assert.equal(f.facts.cancelled, 1);
  }
  const f = fixture(new Uint8Array(256));
  f.onGet = () => new Response(new ReadableStream({ cancel() { f.facts.cancelled++; } }, { highWaterMark: 0 }),
    { status: 206, headers: f.headers });
  assert.equal(await f.send(), "failed"); assert.equal(f.facts.cancelled, 1);
});

test("whole-body checksum validation is still native: corrupt bytes reach that seam unchanged", async () => {
  const f = fixture(new Uint8Array(256).fill(9));
  f.body = f.data.slice(); f.body[0] ^= 1;
  // Model the existing native rejection at the synchronous logReply seam. This
  // test intentionally does not assert a new JS checksum implementation.
  f.onReply = bytes => {
    const result = decode(bytes).get(2);
    assert.notDeepEqual(sha(result.get(0)), result.get(3));
    throw new Error("native whole object checksum mismatch");
  };
  assert.equal(await f.send(), "failed");
  assert.deepEqual(f.facts.failures, [f.id]); assert.ok(f.facts.replyRef.every(b => b === 0));
});

test("exact ranges reject malformed/overflow/out-of-bounds inputs without clamping", async () => {
  for (const range of [[-1, 1], [0, -1], [0.5, 1], [0, 1.5], [257, 0], [255, 2],
    [Number.MAX_SAFE_INTEGER, 1], [0, 1n << 63n], [0], [0, 1, 2], "0-1"]) {
    const f = fixture(new Uint8Array(256), { range });
    assert.equal(await f.send(), "failed"); assert.equal(f.facts.gets, 0);
  }
  const whole = fixture(new Uint8Array(256), { range: [0, 256] });
  assert.equal(await whole.send(), "sent");
  // LS serves partial ranges inline. Fail closed rather than bypass native's
  // full-object hash by slicing a previously unverified Direct whole body.
  const partial = fixture(new Uint8Array(256), { range: [1, 10] });
  assert.equal(await partial.send(), "failed"); assert.equal(partial.facts.gets, 0);
  const inline = fixture(new Uint8Array(256), { range: [1, 10] });
  inline.result.delete(1); inline.result.set(0, inline.data.subarray(1, 11));
  inline.response.set(2, new Map([...inline.result].sort(([a], [b]) => a - b)));
  assert.equal(await inline.send(), "sent"); assert.equal(inline.facts.gets, 0);
  assert.equal(decode(inline.facts.replies[0][1]).get(2).get(0).length, 10);
});

test("session fence after metadata, fetch and each network read prevents stale delivery", async () => {
  for (const stage of ["metadata", "fetch", "read"]) {
    const f = fixture(new Uint8Array(128 << 10));
    if (stage === "metadata") f.onRpc = () => { f.facts.live = false; };
    if (stage === "fetch") f.onGet = () => {
      f.facts.live = false;
      return new Response(byteBody(f.data, f.facts), { status: 206, headers: f.headers });
    };
    if (stage === "read") f.onPull = offset => { if (offset) f.facts.live = false; };
    assert.equal(await f.send(), "dropped");
    assert.equal(f.facts.replies.length, 0); assert.deepEqual(f.facts.failures, []);
    if (stage !== "metadata") assert.equal(f.facts.cancelled, 1);
  }
});

test("expiry and abort after a read cancel the stream and wipe the reusable piece", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = fixture(new Uint8Array(128 << 10));
  f.onPull = offset => { if (offset) now += 60_001; };
  assert.equal(await f.send(), "failed"); assert.equal(f.facts.cancelled, 1);
  assert.equal(f.facts.replies.length, 0);
  const g = fixture(new Uint8Array(128 << 10)), controller = new AbortController();
  const pieces = [];
  g.onPull = offset => { if (offset) controller.abort(); };
  await assert.rejects(streamDirectObject(g.log, g.transfer, g.data.length, g.checksum, () => true, origins,
    () => true, piece => { pieces.push(piece); return true; }, controller.signal));
  assert.equal(g.facts.cancelled, 1);
  assert.ok(pieces.every(p => p.byteLength === 0 || p.every(b => b === 0)));
});

test("pinned attachment consumes raw Direct metadata and keeps 64KiB writes/no owned fallback", async () => {
  const f = fixture(new Uint8Array((2 << 20) + 9).fill(7));
  let reserved = 0, total = 0, maxWrite = 0, complete = false, failed = false;
  Object.assign(f.engine, {
    attachmentAllowed: () => true,
    attachmentReserve: (_ticket, count) => { reserved++; assert.equal(count, f.data.length); return true; },
    attachmentWrite: (_ticket, piece) => {
      maxWrite = Math.max(maxWrite, piece.length);
      assert.deepEqual(piece, f.data.subarray(total, total + piece.length)); total += piece.length; return true;
    },
    attachmentComplete: (_ticket, checksum) => { assert.deepEqual(checksum, f.checksum); complete = true; return true; },
    attachmentFailed: () => { failed = true; },
  });
  const lease = { ticket: f.id, session: 1, expectedBytes: f.data.length, frame: f.frame };
  await fetchAttachment(f.log, f.engine, "test-token", lease, () => true, origins);
  assert.equal(f.facts.gets, 1); assert.equal(reserved, 1);
  assert.equal(total, f.data.length); assert.equal(maxWrite, 64 << 10);
  assert.equal(complete, true); assert.equal(failed, false);
  assert.equal(f.facts.replies.length, 0, "metadata interceptor, not engine.logReply");
  assert.ok(f.facts.windows.every(n => n === 64 << 10));
  assert.ok(lease.frame.every(b => b === 0));
});
