// The log transport: bounded streamed reads, and replies for a stale session are
// never fed to an engine (appends keep their exact bytes and outcome apart).
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedBytes, sendCall, StaleAppendStore } from "../src/log.ts";
import { encode } from "../../../packages/sdk/src/cbor.ts";

function engineSpy() {
  const seen = [];
  return {
    seen,
    signRpc: () => new Uint8Array(64),
    logReply: (id, b) => seen.push(["reply", id, b.length]),
    logFailed: (id) => seen.push(["failed", id]),
  };
}

const frame = (method) => encode(new Map([[2, method], [3, new Map()]]));
const nonce = "ab".repeat(32);

function logWith(onRpc) {
  return {
    async fetch(url) {
      if (url.endsWith("/v1/nonce")) return new Response(nonce);
      return onRpc();
    },
  };
}

test("bounded reads refuse an oversized body without trusting Content-Length", async () => {
  const big = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(64));
    },
  });
  await assert.rejects(boundedBytes(new Response(big), 1000), /over budget/);
  await assert.rejects(
    boundedBytes(new Response("x".repeat(10), { headers: { "content-length": "999999" } }), 100),
    /over budget/,
  );
  assert.equal((await boundedBytes(new Response("hello"), 100)).length, 5);
});

test("a reply that resolves after the session moved is not fed; an append is kept apart", async () => {
  let live = true;
  const log = logWith(async () => {
    live = false; // the DO reset while the RPC was out
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const e = engineSpy();
  const stale = new StaleAppendStore();
  await sendCall(log, e, "t", { id: 7, frame: frame("append") }, () => live, stale);
  assert.deepEqual(e.seen, [], "nothing reached the engine");
  assert.equal(stale.count, 1, "exact bytes and outcome kept");
  live = true;
  const e2 = engineSpy();
  const log2 = logWith(async () => {
    live = false;
    return new Response(new Uint8Array([9]));
  });
  await sendCall(log2, e2, "t", { id: 8, frame: frame("read") }, () => live, stale);
  assert.deepEqual(e2.seen, []);
  assert.equal(stale.count, 1, "reads are just dropped");
});

test("a current session still gets replies and failures", async () => {
  const e = engineSpy();
  const stale = new StaleAppendStore();
  await sendCall(logWith(async () => new Response(new Uint8Array([5, 5]))), e, "t", { id: 1, frame: frame("read") }, () => true, stale);
  await sendCall(logWith(async () => new Response("no", { status: 500 })), e, "t", { id: 2, frame: frame("read") }, () => true, stale);
  assert.deepEqual(e.seen, [["reply", 1, 2], ["failed", 2]]);
});

test("stale custody is reserved before sending: when full, an append is not sent and nothing is evicted", async () => {
  const stale = new StaleAppendStore(1, 1 << 20);
  let live = true;
  let sent = 0;
  const log = logWith(async () => {
    sent += 1;
    live = false;
    return new Response(new Uint8Array([1]));
  });
  await sendCall(log, engineSpy(), "t", { id: 1, frame: frame("append") }, () => live, stale);
  assert.equal(stale.count, 1);
  live = true;
  const e = engineSpy();
  await sendCall(log, e, "t", { id: 2, frame: frame("append") }, () => live, stale);
  assert.equal(sent, 1, "no credit: the second append was not sent");
  assert.deepEqual(e.seen, [["failed", 2]], "busy: the engine retries the same bytes later");
  assert.equal(stale.count, 1, "the held outcome was not evicted");
});

test("the fence is checked after the RPC fetch, before the body is read into an engine", async () => {
  let live = true;
  const log = {
    async fetch(url) {
      if (url.endsWith("/v1/nonce")) return new Response(nonce);
      live = false;
      return new Response(new Uint8Array([7, 7]));
    },
  };
  const e = engineSpy();
  await sendCall(log, e, "t", { id: 3, frame: frame("head") }, () => live, new StaleAppendStore());
  assert.deepEqual(e.seen, []);
});

test("the bytes signed, sent and retained are the ones captured before any await", async () => {
  let live = true;
  const call = { id: 7, frame: frame("append") };
  const original = call.frame.slice();
  let sent;
  const log = {
    async fetch(url, init) {
      if (url.endsWith("/v1/nonce")) {
        // A caller mutates the call while the nonce is out.
        call.id = 99;
        call.frame = frame("read");
        return new Response(nonce);
      }
      sent = new Uint8Array(init.body);
      live = false;
      return new Response(new Uint8Array([1]));
    },
  };
  let signed;
  const e = { ...engineSpy(), signRpc: (_m, _k, _t, bytes) => { signed = bytes.slice(); return new Uint8Array(64); } };
  const stale = new StaleAppendStore();
  const kept = [];
  const orig = stale.settle.bind(stale);
  stale.settle = (n, a) => { if (a) kept.push(a); orig(n, a); };
  await sendCall(log, e, "t", call, () => live, stale);
  assert.deepEqual([...signed], [...original], "signed the original");
  assert.deepEqual([...sent], [...original], "sent the original");
  assert.equal(kept[0].id, 7, "retained under the original ID");
  assert.deepEqual([...kept[0].frame], [...original], "retained the original bytes");
});
