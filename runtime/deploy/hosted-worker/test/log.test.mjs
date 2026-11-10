// The log transport: bounded streamed reads, and replies for a stale session are
// never fed to an engine (appends keep their exact bytes and outcome apart).
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedBytes, deploymentLog, pumpLog, PumpReport, sendCall, SpareNonces, StaleAppendStore } from "../src/log.ts";
import { decode, encode } from "../../../packages/sdk/src/cbor.ts";

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

test("the pump report: reads remain work and are counted separately for native replay classification", async () => {
  const run = async (methods, status = 200) => {
    const report = new PumpReport();
    const e = pumpEngine([methods.map((m, id) => ({ id, frame: frame(m) }))]);
    await pumpLog(logWith(async () => new Response(new Uint8Array([1]), { status })), e, async () => "t", () => true, new StaleAppendStore(), 64, undefined, undefined, undefined, { report });
    return report;
  };
  assert.equal((await run([])).quiet, true);
  assert.equal((await run(["subscribe", "head", "unsubscribe"])).quiet, true);
  assert.equal((await run(["read"])).reads, 1);
  assert.equal((await run(["read"], 503)).reads, 0);
  for (const m of ["read", "append", "put_object", "get_snapshot"]) assert.equal((await run(["subscribe", m])).quiet, false, m);
  assert.equal((await run(["subscribe"], 503)).quiet, false, "a failed head check is retried soon, not idle");
});

// Piggybacked nonces: a log Worker that mints `x-mdbase-next-nonce` on every RPC
// response and, like the log actor, refuses a nonce it has seen (or `expire`s)
// with an ls-response before dispatching anything.
function nonceLog({ piggyback = true, expire = () => false, rpc } = {}) {
  let minted = 0;
  const mint = () => (++minted).toString(16).padStart(64, "0");
  const used = new Set();
  const f = {
    requests: [], dispatched: [], gets: 0,
    async fetch(url, init) {
      const path = new URL(url).pathname;
      f.requests.push(path);
      if (path === "/v1/nonce") { f.gets++; return new Response(mint()); }
      const headers = piggyback ? { "x-mdbase-next-nonce": mint() } : {};
      const n = init.headers["x-mdbase-nonce"];
      const id = decode(new Uint8Array(init.body)).get(1) ?? 0;
      if (used.has(n) || expire(n)) {
        return new Response(encode(new Map([[0, 1], [1, id], [3, new Map([[0, "unauthenticated"], [1, used.has(n) ? "replay" : "nonce"]])]])), { headers });
      }
      used.add(n);
      f.dispatched.push(decode(new Uint8Array(init.body)).get(2));
      if (rpc) return rpc(headers);
      return new Response(encode(new Map([[0, 1], [1, id], [2, null]])), { headers });
    },
  };
  return f;
}
const calls = (n, method = "read") => Array.from({ length: n }, (_, id) => ({ id, frame: frame(method) }));

test("N sequential calls are N+1 requests, each on its own nonce, and the nonce outlives the pump", async () => {
  const log = nonceLog();
  const nonces = new SpareNonces();
  const signed = [];
  const e = Object.assign(pumpEngine([calls(5), calls(3)]), { signRpc: (_m, _k, _t, _b, n) => { signed.push([...n].join()); return new Uint8Array(64); } });
  await pumpLog(log, e, async () => "t", () => true, new StaleAppendStore(), 64, undefined, undefined, undefined, { nonces });
  assert.equal(log.requests.length, 8 + 1, "one GET /v1/nonce, then one POST per call");
  assert.deepEqual(log.requests.slice(0, 2), ["/v1/nonce", "/v1/rpc"]);
  assert.equal(new Set(signed).size, 8, "never the same nonce twice");
  assert.equal(e.seen.filter(([k]) => k === "reply").length, 8);
  // A later pump on the same actor starts from the kept spare: no GET at all.
  await pumpLog(log, pumpEngine([calls(2)]), async () => "t", () => true, new StaleAppendStore(), 64, undefined, undefined, undefined, { nonces });
  assert.equal(log.gets, 1);
});

test("a log without the header (the previous log Worker) gets GET /v1/nonce per call, as before", async () => {
  const log = nonceLog({ piggyback: false });
  await pumpLog(log, pumpEngine([calls(3)]), async () => "t", () => true, new StaleAppendStore());
  assert.deepEqual(log.requests, ["/v1/nonce", "/v1/rpc", "/v1/nonce", "/v1/rpc", "/v1/nonce", "/v1/rpc"]);
});

test("a spare too old to be safe is dropped for a fresh one; eviction just loses the pool", async () => {
  let now = 1_000;
  const nonces = new SpareNonces(() => now);
  const log = nonceLog();
  await sendCall(log, engineSpy(), "t", { id: 1, frame: frame("read") }, () => true, new StaleAppendStore(), undefined, undefined, undefined, nonces);
  now += 41_000;
  await sendCall(log, engineSpy(), "t", { id: 2, frame: frame("read") }, () => true, new StaleAppendStore(), undefined, undefined, undefined, nonces);
  assert.deepEqual(log.requests, ["/v1/nonce", "/v1/rpc", "/v1/nonce", "/v1/rpc"]);
});

test("a refused spare recovers with one retry on a fresh nonce; a refused fresh nonce is not retried", async () => {
  for (const why of ["replay", "nonce"]) {
    const log = nonceLog({ expire: (n) => n === "e".repeat(64) });
    const nonces = new SpareNonces();
    if (why === "replay") {
      // The spare was already consumed on the server (by a call it raced): the
      // warm-up call's GET minted nonce 1 and used it.
      await sendCall(log, engineSpy(), "t", { id: 0, frame: frame("read") }, () => true, new StaleAppendStore());
      nonces.keep(new Headers({ "x-mdbase-next-nonce": "0".repeat(63) + "1" }));
    } else nonces.keep(new Headers({ "x-mdbase-next-nonce": "e".repeat(64) })); // expired
    log.requests.length = 0;
    log.dispatched.length = 0;
    const e = engineSpy();
    assert.equal(await sendCall(log, e, "t", { id: 1, frame: frame("append") }, () => true, new StaleAppendStore(), undefined, undefined, undefined, nonces), "sent", why);
    assert.deepEqual(log.requests, ["/v1/rpc", "/v1/nonce", "/v1/rpc"], why);
    assert.deepEqual(log.dispatched, ["append"], `${why}: dispatched once`);
    assert.deepEqual(e.seen, [["reply", 1, 7]], `${why}: the engine sees only the real reply`);
  }
  // Every nonce refused: the fresh-nonce attempt's refusal goes to the engine as is.
  const log = nonceLog({ expire: () => true });
  const nonces = new SpareNonces();
  nonces.keep(new Headers({ "x-mdbase-next-nonce": "e".repeat(64) }));
  const e = engineSpy();
  await sendCall(log, e, "t", { id: 1, frame: frame("read") }, () => true, new StaleAppendStore(), undefined, undefined, undefined, nonces);
  assert.deepEqual(log.requests, ["/v1/rpc", "/v1/nonce", "/v1/rpc"], "no loop");
  assert.equal(e.seen.length, 1);
  assert.equal(log.dispatched.length, 0);
});

test("nonce recovery never resends an append whose outcome is unknown", async () => {
  const spare = () => { const n = new SpareNonces(); n.keep(new Headers({ "x-mdbase-next-nonce": "c".repeat(64) })); return n; };
  const outcomes = [
    ["transport error", () => { throw new Error("connection reset"); }, "failed"],
    ["HTTP 500", (headers) => new Response("", { status: 500, headers }), "failed"],
    ["HTTP 503", (headers) => new Response("", { status: 503, headers }), "failed"],
    ["over-budget reply", (headers) => new Response(new Uint8Array((64 << 10) + 1), { headers }), "failed"],
  ];
  for (const [name, rpc, outcome] of outcomes) {
    const log = nonceLog({ rpc });
    const e = engineSpy();
    assert.equal(await sendCall(log, e, "t", { id: 1, frame: frame("append") }, () => true, new StaleAppendStore(), undefined, undefined, undefined, spare()), outcome, name);
    assert.deepEqual(log.requests, ["/v1/rpc"], `${name}: sent once`);
    assert.deepEqual(e.seen, [["failed", 1]], `${name}: the engine retries the same bytes, as before`);
  }
  // The session moved while the append was out: kept apart, as before, not resent.
  let live = true;
  const log = nonceLog({ rpc: (headers) => { live = false; return new Response(new Uint8Array([1]), { headers }); } });
  const stale = new StaleAppendStore();
  assert.equal(await sendCall(log, engineSpy(), "t", { id: 1, frame: frame("append") }, () => live, stale, undefined, undefined, undefined, spare()), "dropped");
  assert.deepEqual(log.requests, ["/v1/rpc"]);
  assert.equal(stale.count, 1);
  // A refused spare whose session moved meanwhile is kept, not resent.
  live = true;
  const refusing = nonceLog({ expire: () => { live = false; return true; } });
  const stale2 = new StaleAppendStore();
  assert.equal(await sendCall(refusing, engineSpy(), "t", { id: 1, frame: frame("append") }, () => live, stale2, undefined, undefined, undefined, spare()), "dropped");
  assert.deepEqual(refusing.requests, ["/v1/rpc"]);
  assert.equal(stale2.count, 1);
});
