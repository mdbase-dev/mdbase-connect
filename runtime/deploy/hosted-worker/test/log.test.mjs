// The log transport: bounded streamed reads, and replies for a stale session are
// never fed to an engine (appends keep their exact bytes and outcome apart).
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedBytes, deploymentLog, pumpLog, PumpReport, sendCall, StaleAppendStore } from "../src/log.ts";
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

test("cross-account HTTPS log transport requires no service binding and never falls back on malformed origin", async (t) => {
  const binding = {fetch() { throw new Error("binding must not be used"); }};
  assert.equal(deploymentLog({LOG: binding}), binding);
  assert.throws(() => deploymentLog({}), /log_unconfigured/);
  for (const LOG_URL of ["http://log.test", "https://log.test/path", "https://log.test?bad"]) {
    assert.throws(() => deploymentLog({LOG_URL, LOG: binding}), /https origin/);
  }
  let seen;
  t.mock.method(globalThis, "fetch", async (url, init) => { seen = {url, init}; return new Response("nonce"); });
  const log = deploymentLog({LOG_URL: "https://log.test"});
  await log.fetch("https://log.internal/v1/nonce?collection=unit");
  assert.equal(seen.url, "https://log.test/v1/nonce?collection=unit");
  assert.equal(seen.init.redirect, "manual");
  assert.notEqual(deploymentLog({LOG_URL: "https://log.test", LOG: binding}), binding, "public origin precedes binding");
});

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

// A pump engine: queued rounds of calls; logBound after the first token.
function pumpEngine(rounds) {
  const e = engineSpy();
  let i = 0;
  return Object.assign(e, {
    logBound: true,
    logCalls: () => rounds[i++] ?? [],
    logBind: () => true,
  });
}

test("sendCall reports its outcome; a log 401/403 is a refusal", async () => {
  for (const [status, outcome] of [[200, "sent"], [401, "refused"], [403, "refused"], [500, "failed"], [429, "failed"]]) {
    const e = engineSpy();
    const got = await sendCall(logWith(async () => new Response(new Uint8Array([1]), { status })), e, "t", { id: 1, frame: frame("read") }, () => true, new StaleAppendStore());
    assert.equal(got, outcome, `HTTP ${status}`);
  }
  assert.equal(await sendCall(logWith(async () => new Response("x")), engineSpy(), "t", { id: 1, frame: frame("read") }, () => false, new StaleAppendStore()), "dropped");
});

test("a log 401/403 drops the held token and mints a fresh one once; the refused round fails back to the engine", async () => {
  const statuses = [401, 200];
  const tokens = [];
  let minted = 0, dropped = 0;
  const log = logWith(async () => new Response(new Uint8Array([1]), { status: statuses.shift() ?? 200 }));
  const e = pumpEngine([[{ id: 1, frame: frame("read") }, { id: 2, frame: frame("read") }], [{ id: 3, frame: frame("read") }]]);
  await pumpLog(log, e, async () => { tokens.push(++minted); return `t${minted}`; }, () => true, new StaleAppendStore(), 64, undefined, undefined, undefined,
    { tokenRefused: () => { dropped++; } });
  assert.equal(dropped, 1);
  assert.equal(minted, 2, "the next round asked custody again (the held token was dropped)");
  assert.deepEqual(e.seen, [["failed", 1], ["failed", 2], ["reply", 3, 1]], "the unsent rest of the refused round failed back, not sent with the refused bearer");
});

test("a second refusal after the fresh token ends the pump", async () => {
  let minted = 0, dropped = 0, sent = 0;
  const log = logWith(async () => { sent++; return new Response("", { status: 403 }); });
  const e = pumpEngine([[{ id: 1, frame: frame("read") }], [{ id: 2, frame: frame("read") }], [{ id: 3, frame: frame("read") }]]);
  await pumpLog(log, e, async () => `t${++minted}`, () => true, new StaleAppendStore(), 64, undefined, undefined, undefined,
    { tokenRefused: () => { dropped++; } });
  assert.deepEqual({ minted, dropped, sent }, { minted: 2, dropped: 2, sent: 2 });
});

test("the pump report: head checks alone are quiet; reads, appends and failures are not", async () => {
  const run = async (methods, status = 200) => {
    const report = new PumpReport();
    const e = pumpEngine([methods.map((m, id) => ({ id, frame: frame(m) }))]);
    await pumpLog(logWith(async () => new Response(new Uint8Array([1]), { status })), e, async () => "t", () => true, new StaleAppendStore(), 64, undefined, undefined, undefined, { report });
    return report;
  };
  assert.equal((await run([])).quiet, true);
  assert.equal((await run(["subscribe", "head", "unsubscribe"])).quiet, true);
  for (const m of ["read", "append", "put_object", "get_snapshot"]) assert.equal((await run(["subscribe", m])).quiet, false, m);
  assert.equal((await run(["subscribe"], 503)).quiet, false, "a failed head check is retried soon, not idle");
});
