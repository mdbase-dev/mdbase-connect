// Local runtime harness only. Not referenced by deploy config or artifacts.
// HTTP framing cannot express a length lie without changing the framing; use
// real native Request byte streams inside workerd, through production handlers.
import worker, {
  LogCollection as RustCollection,
} from "../build/worker/shim.mjs";
async function invoke(q, env, ctx, actorHandler, onPut) {
  if (!Number.isSafeInteger(q.size) || q.size < 0 || q.size > 32 * 1024 * 1024)
    throw Error("test size");
  const prefix = Uint8Array.from(atob(q.prefix ?? ""), (x) => x.charCodeAt(0));
  let emitted = 0,
    pulls = 0,
    cancelled = false,
    maxView = 0,
    forwarded = 0,
    r2writes = 0,
    r2gets = 0,
    r2cancels = 0;
  const body = new ReadableStream({
    type: "bytes",
    async pull(c) {
      pulls++;
      if (q.delay) await new Promise((r) => setTimeout(r, q.delay));
      if (q.errorAt !== undefined && emitted >= q.errorAt) {
        c.error(
          q.abort
            ? new DOMException("aborted", "AbortError")
            : new Error("reader error"),
        );
        return;
      }
      if (emitted === q.size) {
        c.close();
        c.byobRequest?.respond(0);
        return;
      }
      const view = c.byobRequest?.view;
      if (view) maxView = Math.max(maxView, view.byteLength);
      const n = Math.min(
        q.size - emitted,
        q.chunk ?? 4096,
        q.oversizedChunk ? Infinity : (view?.byteLength ?? 4096),
      );
      const out =
        q.oversizedChunk || !view
          ? new Uint8Array(n)
          : new Uint8Array(view.buffer, view.byteOffset, n);
      out.fill(q.fill ?? 0);
      for (let i = emitted; i < Math.min(emitted + n, prefix.length); i++)
        out[i - emitted] = prefix[i];
      emitted += n;
      if (q.oversizedChunk || !view) c.enqueue(out);
      else c.byobRequest.respond(n);
    },
    cancel() {
      cancelled = true;
    },
  });
  const incoming = new Request(q.url ?? "https://worker/v1/rpc", {
    method: q.method ?? "POST",
    headers: q.headers ?? {},
    ...(q.method === "GET" || q.method === "HEAD" ? {} : { body }),
  });
  // Direct-download seams are request-local. Inherit the actual native binding's
  // constructor (workers-rs validates its name), but call every method on its
  // ORIGINAL receiver. No global binding override or Proxy is used here.
  if (q.directGet) {
    if (!Number.isInteger(q.delayR2Get ?? 0) || (q.delayR2Get ?? 0) < 0 || (q.delayR2Get ?? 0) > 2000 || q.size > 64 * 1024) throw Error("bounded direct-download seam");
    const bucket = env.OBJECTS;
    if (q.seedR2) {
      if (prefix.length > 64 * 1024) throw Error("bounded R2 fixture");
      await bucket.put(q.seedR2.key, prefix, {
        sha256: Uint8Array.from(atob(q.seedR2.sha256), (x) => x.charCodeAt(0)),
        customMetadata: q.seedR2.metadata,
      });
    }
    const scoped = Object.create(bucket);
    for (const name of ["head", "get", "put", "delete", "list", "createMultipartUpload", "resumeMultipartUpload"]) {
      if (typeof bucket[name] === "function") Object.defineProperty(scoped, name, { value: bucket[name].bind(bucket), configurable: true });
    }
    Object.defineProperty(scoped, "get", { configurable: true, value: async (...args) => {
      r2gets++;
      const obj = await bucket.get(...args);
      if (!obj) return obj;
      // Observe cancellation of the actual acquired native body, not a fake
      // response stream. Metadata/range remain untouched unless explicitly faulted.
      const stream = obj.body;
      if (stream) {
        const cancel = stream.cancel;
        Object.defineProperty(stream, "cancel", { value: (...a) => {
          r2cancels++;
          return cancel.apply(stream, a);
        } });
      }
      if (q.delayR2Get) await new Promise((r) => setTimeout(r, q.delayR2Get));
      if (!q.getMetadata) return obj;
      // Snapshot native plain metadata using the native receiver. Inheriting
      // native object getters would instead throw an illegal-this invocation.
      return { version: obj.version, size: obj.size, etag: obj.etag, range: obj.range,
        body: stream, customMetadata: q.getMetadata };
    } });
    const result = await new worker(ctx, { ...env, OBJECTS: scoped }).fetch(incoming);
    let response, lockedBeforeCancel;
    if (q.cancelResponse) {
      // Pause without a reader, then cancel the actual response body. This is
      // consumer-abort evidence, NOT instrumentation of R2 prefetch/heap limits.
      await new Promise((r) => setTimeout(r, 25));
      lockedBeforeCancel = result.body.locked;
      await result.body.cancel("test-only consumer abort");
      response = [];
    } else response = Array.from(new Uint8Array(await result.arrayBuffer()));
    return {
      status: result.status,
      response, lockedBeforeCancel,
      contentLength: result.headers.get("content-length"),
      contentRange: result.headers.get("content-range"),
      checksum: result.headers.get("x-amz-checksum-sha256"),
      emitted, pulls, cancelled, maxView, forwarded, r2writes, r2gets, r2cancels,
    };
  }
  // Keep the real native bindings (a Proxy cannot be cast by workers-rs).
  const put = env.OBJECTS.put,
    getByName = env.LOG.getByName;
  env.OBJECTS.put = async function (...a) {
    r2writes++;
    onPut?.();
    if (q.delayPut) await new Promise((r) => setTimeout(r, q.delayPut));
    return put.apply(this, a);
  };
  env.LOG.getByName = function (...a) {
    forwarded++;
    return getByName.apply(this, a);
  };
  let result;
  try {
    result = actorHandler
      ? await actorHandler(incoming)
      : await new worker(ctx, env).fetch(incoming);
  } finally {
    env.OBJECTS.put = put;
    env.LOG.getByName = getByName;
  }
  const response = Array.from(new Uint8Array(await result.arrayBuffer()));
  return {
    status: result.status,
    cborNodes: result.headers.get("x-logsvc-cbor-nodes"),
    cborDecoded: result.headers.get("x-logsvc-cbor-decoded"),
    cborReason: result.headers.get("x-logsvc-cbor-reason"),
    response,
    emitted,
    pulls,
    cancelled,
    maxView,
    forwarded,
    r2writes,
  };
}
// Construct the instrumented stream inside the actor. Stub.fetch otherwise
// adds its own pipe/HTTP framing and may consume the source using a default
// reader, obscuring the production actor reader's bound/cancellation.
export class LogCollection extends RustCollection {
  constructor(state, env) {
    super(state, env);
    this.testState = state;
    this.testEnv = env;
  }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/__test/registry-pre-turn") {
      const q = await req.json();
      const bytes = Uint8Array.from(atob(q.body), x => x.charCodeAt(0));
      if (bytes.length > 1024 || this.registryPause) throw Error("bounded single registry pre-turn fixture");
      let resume;
      const gate = new Promise(resolve => { resume = resolve; });
      const pause = this.registryPause = { reached: false, resume };
      let emitted = false;
      const body = new ReadableStream({ type: "bytes", async pull(c) {
        if (emitted) { c.close(); c.byobRequest?.respond(0); return; }
        pause.reached = true;
        await gate;
        emitted = true;
        const view = c.byobRequest?.view;
        if (!view || view.byteLength < bytes.length) throw Error("native bounded BYOB pre-turn");
        new Uint8Array(view.buffer, view.byteOffset, bytes.length).set(bytes);
        c.byobRequest.respond(bytes.length);
      } });
      try {
        const response = await super.fetch(new Request(q.url, { method: "POST", headers: q.headers, body }));
        return Response.json({ status: response.status, response: Array.from(new Uint8Array(await response.arrayBuffer())) });
      } finally { pause.resume(); this.registryPause = undefined; }
    }
    if (path === "/__test/registry-pause-state") return Response.json({ paused: this.registryPause?.reached === true });
    if (path === "/__test/resume-registry") {
      if (!this.registryPause?.reached) return new Response("not paused", { status: 409 });
      this.registryPause.resume(); return new Response("ok");
    }
    if (path === "/__test/registry-closing-state") {
      const { target } = await req.json();
      if (typeof target !== "string" || !/^[0-9a-f]{32}$/.test(target)) throw Error("target fixture");
      const c = Uint8Array.from(target.match(/../g), x => parseInt(x,16)).buffer;
      const sql = this.testState.storage.sql;
      const hex = b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2,"0")).join("");
      const rows = q => [...sql.exec(q,c).raw()].map(row => row.map(v => v instanceof ArrayBuffer ? hex(v) : v));
      return Response.json({
        closing: rows("SELECT substr(version,1,16), length(version), substr(deletion_id,1,16), length(deletion_id), substr(lifecycle_epoch,1,8), length(lifecycle_epoch), substr(first_started_at_ms,1,8), length(first_started_at_ms) FROM collection_closing WHERE collection = ?"),
        floor: rows("SELECT deletion_id, lifecycle_epoch FROM collection_deletion_floor WHERE collection = ?"),
        revision: [...sql.exec("SELECT revision FROM collection_deletion_revision WHERE k = 0").raw()].map(([v]) => hex(v)),
      });
    }
    if (path === "/__test/registry-seed-legacy-closing") {
      const { target } = await req.json();
      if (typeof target !== "string" || !/^[0-9a-f]{32}$/.test(target)) throw Error("target fixture");
      this.testState.storage.sql.exec("INSERT INTO collection_closing VALUES (?, x'00', zeroblob(1048576), zeroblob(8), zeroblob(8))",
        Uint8Array.from(target.match(/../g),x => parseInt(x,16)).buffer);
      return new Response("ok");
    }
    if (path === "/__test/registry-corrupt-closing") {
      const { target, field } = await req.json();
      if (typeof target !== "string" || !/^[0-9a-f]{32}$/.test(target)) throw Error("target fixture");
      const updates = {
        version: "UPDATE collection_closing SET version = zeroblob(1048576) WHERE collection = ?",
        deletion: "UPDATE collection_closing SET deletion_id = zeroblob(1048576) WHERE collection = ?",
        epoch: "UPDATE collection_closing SET lifecycle_epoch = zeroblob(1048576) WHERE collection = ?",
        start: "UPDATE collection_closing SET first_started_at_ms = zeroblob(1048576) WHERE collection = ?",
      };
      if (!Object.hasOwn(updates,field)) throw Error("bounded corruption field");
      this.testState.storage.sql.exec(updates[field],Uint8Array.from(target.match(/../g),x => parseInt(x,16)).buffer);
      return new Response("ok");
    }
    if (path === "/__test/registry-clock" || path === "/__test/registry-read-fault") {
      const q = await req.json(), storage = this.testState.storage, sql = storage.sql;
      const bytes = Uint8Array.from(atob(q.body), x => x.charCodeAt(0));
      if (bytes.length > 1024) throw Error("bounded native clock fixture");
      const clocks = { nan: NaN, "positive-infinity": Infinity, "negative-infinity": -Infinity,
        negative: -1, zero: 0, "negative-zero": -0, fractional: 123.5, "positive-submillisecond": 0.5,
        minimum: 1, ordinary: 1792000000123, "max-minus-one": Number.MAX_SAFE_INTEGER-30001,
        max: Number.MAX_SAFE_INTEGER-30000, "max-plus-one": Number.MAX_SAFE_INTEGER-29999,
        "safe-integer-max": Number.MAX_SAFE_INTEGER, "unsafe-integer": 2**53,
        "i64-max-as-float": 2**63, boolean: true, string: "1792000000123" };
      const readFault = path.endsWith("read-fault");
      if (!readFault && !Object.hasOwn(clocks,q.clock)) throw Error("clock label");
      const transactionSync = storage.transactionSync;
      let clockCalls = 0;
      if (readFault) sql.exec("ALTER TABLE collection_closing RENAME TO test_saved_collection_closing");
      else storage.transactionSync = function(callback) {
        return transactionSync.call(this, () => {
          const nativeNow = Date.now;
          Date.now = () => { clockCalls++; return clocks[q.clock]; };
          try { return callback(); } finally { Date.now = nativeNow; }
        });
      };
      if (q.failWrite) sql.exec("CREATE TRIGGER test_refuse_closing BEFORE INSERT ON collection_closing BEGIN SELECT RAISE(FAIL, 'test-only write failure'); END");
      try {
        const response = await super.fetch(new Request(q.url,{method:"POST",headers:q.headers,body:bytes}));
        return Response.json({status:response.status,clockCalls,response:Array.from(new Uint8Array(await response.arrayBuffer()))});
      } finally {
        if (readFault) sql.exec("ALTER TABLE test_saved_collection_closing RENAME TO collection_closing");
        else storage.transactionSync = transactionSync;
        if (q.failWrite) sql.exec("DROP TRIGGER test_refuse_closing");
      }
    }
    if (path === "/__test/destination-read-fault" || path === "/__test/destination-write-fault") {
      const q = await req.json();
      const bytes = Uint8Array.from(atob(q.body), x => x.charCodeAt(0));
      if (bytes.length > 4096) throw Error("bounded denial SQL fault fixture");
      const sql = this.testState.storage.sql;
      const readFault = path.endsWith("read-fault");
      if (readFault) sql.exec("ALTER TABLE log_destination_denial RENAME TO test_saved_destination_denial");
      else sql.exec("CREATE TRIGGER test_refuse_destination_denial BEFORE INSERT ON log_destination_denial BEGIN SELECT RAISE(FAIL, 'test-only write failure'); END");
      try {
        const response = await super.fetch(new Request(q.url, { method: "POST", headers: q.headers, body: bytes }));
        return Response.json({ status: response.status,
          response: Array.from(new Uint8Array(await response.arrayBuffer())) });
      } finally {
        if (readFault) sql.exec("ALTER TABLE test_saved_destination_denial RENAME TO log_destination_denial");
        else sql.exec("DROP TRIGGER test_refuse_destination_denial");
      }
    }
    if (path === "/__test/floor-pause-state") {
      return Response.json({ paused: this.floorPause?.reached === true });
    }
    if (path === "/__test/resume-floor") {
      if (!this.floorPause?.reached) return new Response("not paused", { status: 409 });
      this.floorPause.resume();
      return new Response("ok");
    }
    if (path === "/__test/corrupt-destination-denial") {
      // Bounded test-only corruption, never a deployed administrative route.
      this.testState.storage.sql.exec("UPDATE log_destination_denial SET version = x'ff', lifecycle_epoch = x'00'");
      return new Response("ok");
    }
    if (path === "/__test/destination-state") {
      const sql = this.testState.storage.sql;
      const hex = (b) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");
      const rows = (q) => [...sql.exec(q).raw()].map(row => row.map(v => v instanceof ArrayBuffer ? hex(v) : v));
      return Response.json({
        denial: rows("SELECT version, collection, deletion_id, lifecycle_epoch FROM log_destination_denial"),
        meta: rows("SELECT id, meta FROM meta"),
        acl: rows("SELECT device, account, kind, sign_pk, active FROM acl ORDER BY device"),
        items: rows("SELECT seq, kind, bytes, appended_at FROM items ORDER BY seq LIMIT 12000"),
        objects: rows("SELECT address, kind, size, checksum, committed, created_at FROM objects ORDER BY address LIMIT 512"),
        refs: rows("SELECT address, holder_kind, holder FROM object_refs ORDER BY address, holder_kind, holder LIMIT 12000"),
        snapshots: rows("SELECT seq, manifest, author, created_at, endorsed FROM snapshots ORDER BY seq LIMIT 512"),
        tokens: rows("SELECT token, seq, expires_at FROM tokens ORDER BY token LIMIT 12000"),
        aux: rows("SELECT * FROM restore_aux"),
        auxTokens: rows("SELECT token, seq, expires_at FROM restore_aux_tokens ORDER BY token LIMIT 12000"),
      });
    }
    if (path === "/__test/floor-actor") {
      // Fault only the backend-owned nil lookup inside the actual Rust actor.
      // Keep native namespace/stub receivers (workers-rs rejects fake bindings).
      const q = await req.json();
      const namespace = this.testEnv.LOG, getByName = namespace.getByName;
      let pause;
      if (q.fault === "pause") {
        if (this.floorPause) throw Error("one bounded paused producer per actor");
        const at = q.pauseAt ?? 1;
        if (!Number.isInteger(at) || at < 1 || at > 3) throw Error("bounded actual floor pause ordinal");
        let resume;
        const gate = new Promise(resolve => { resume = resolve; });
        pause = this.floorPause = { reached: false, resume, gate, at };
      }
      let calls = 0;
      namespace.getByName = function (name, ...args) {
        const stub = getByName.call(this, name, ...args);
        if (name !== "00000000-0000-0000-0000-000000000000") return stub;
        const fetch = stub.fetch;
        stub.fetch = async function (...args) {
          const url = new URL(typeof args[0] === "string" ? args[0] : args[0].url);
          if (url.pathname !== "/registry/collection-deletion") return fetch.apply(this, args);
          calls++;
          if (q.fault === "unreachable") throw Error("test-only nil unavailable");
          const actual = await fetch.apply(this, args);
          if (pause && calls === pause.at) {
            // Hold the real native absent reply while the Rust DoTxn still owns
            // its awaited writer lock. A separate genuine CP close must finish.
            pause.reached = true;
            await pause.gate;
            return actual;
          }
          if (pause || q.fault === "actual") return actual;
          await actual.body?.cancel();
          if (q.fault === "status") return new Response(null, { status: 503 });
          if (q.fault === "empty") return new Response(null);
          const bytes = Uint8Array.from(atob(q.reply), x => x.charCodeAt(0));
          if (bytes.length > 2048) throw Error("bounded floor fault fixture");
          if (q.fault === "default-reader") {
            return new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
          }
          return new Response(bytes);
        };
        return stub;
      };
      try {
        const response = await super.fetch(new Request(q.url, {
          method: "POST", headers: q.headers,
          body: Uint8Array.from(atob(q.body), x => x.charCodeAt(0)),
        }));
        return Response.json({ status: response.status, calls,
          response: Array.from(new Uint8Array(await response.arrayBuffer())) });
      } finally {
        namespace.getByName = getByName;
        if (pause) { pause.resume(); this.floorPause = undefined; }
      }
    }
    if (path === "/__test/age-aux-fixture") {
      this.testState.storage.sql.exec("UPDATE items SET appended_at = 1000 + seq");
      this.testState.storage.sql.exec("UPDATE tokens SET expires_at = 2000 + seq");
      this.testState.storage.sql.exec("UPDATE snapshots SET created_at = 1000");
      return new Response("ok");
    }
    if (path === "/__test/aux-state") {
      const sql = this.testState.storage.sql;
      const hex = (b) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2,"0")).join("");
      return Response.json({
        items: [...sql.exec("SELECT seq, appended_at FROM items ORDER BY seq LIMIT 12000").raw()],
        objects: [...sql.exec("SELECT address, created_at FROM objects WHERE committed = 1 ORDER BY address LIMIT 512").raw()].map(([a,t])=>[hex(a),t]),
        tokens: [...sql.exec("SELECT token, seq, expires_at FROM tokens ORDER BY token LIMIT 12000").raw()].map(([a,s,t])=>[hex(a),s,t]),
        snapshots: [...sql.exec("SELECT seq, created_at, endorsed FROM snapshots ORDER BY seq LIMIT 512").raw()],
        meta: [...sql.exec("SELECT meta FROM meta WHERE k = 0").raw()].map(([m])=>hex(m)),
        aux: [...sql.exec("SELECT page, done FROM restore_aux WHERE k = 0").raw()],
      });
    }
    if (path === "/__test/expire-cut" || path === "/__test/age-objects") {
      this.testState.storage.sql.exec(path === "/__test/expire-cut"
        ? "UPDATE backup_cut SET expires_at = 0 WHERE k = 0"
        : "UPDATE objects SET created_at = 0");
      return new Response("ok");
    }
    if (new URL(req.url).pathname !== "/__test/actor") return super.fetch(req);
    return Response.json(
      await invoke(await req.json(), this.testEnv, this.testState, (r) =>
        super.fetch(r),
      ),
    );
  }
}
async function route(q, env, ctx) {
  if (!q.actor) return invoke(q, env, ctx);
  const r = await env.LOG.get(env.LOG.idFromName(q.actor)).fetch(
    "https://do/__test/actor",
    { method: "POST", body: JSON.stringify(q) },
  );
  return r.json();
}
export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (["/__test/floor-actor", "/__test/destination-read-fault", "/__test/destination-write-fault",
      "/__test/registry-pre-turn", "/__test/registry-pause-state", "/__test/resume-registry",
      "/__test/registry-closing-state", "/__test/registry-corrupt-closing", "/__test/registry-seed-legacy-closing", "/__test/registry-clock", "/__test/registry-read-fault"].includes(path)) {
      const q = await req.json();
      if (typeof q.actor !== "string" || !/^[0-9a-f-]{36}$/.test(q.actor)) return new Response("actor", { status: 400 });
      return env.LOG.get(env.LOG.idFromName(q.actor)).fetch(`https://do${path}`, {
        method: "POST", body: JSON.stringify(q),
      });
    }
    if (["/__test/expire-cut", "/__test/age-objects", "/__test/aux-state", "/__test/age-aux-fixture",
      "/__test/floor-pause-state", "/__test/resume-floor", "/__test/destination-state", "/__test/corrupt-destination-denial"].includes(path)) {
      const { actor } = await req.json();
      if (typeof actor !== "string" || !/^[0-9a-f-]{36}$/.test(actor)) return new Response("actor", { status: 400 });
      return env.LOG.get(env.LOG.idFromName(actor)).fetch(`https://do${path}`);
    }
    if (new URL(req.url).pathname !== "/__test/ingress")
      return new worker(ctx, env).fetch(req);
    const q = await req.json();
    if (q.afterPut) {
      let opened;
      const gate = new Promise((r) => {
        opened = r;
      });
      const first = invoke(q.afterPut[0], env, ctx, undefined, opened);
      await gate;
      const second = await invoke(q.afterPut[1], env, ctx);
      return Response.json([await first, second]);
    }
    return Response.json(
      q.parallel
        ? await Promise.all(q.parallel.map((x) => route(x, env, ctx)))
        : await route(q, env, ctx),
    );
  },
};
