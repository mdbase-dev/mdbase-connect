// Hermetic regression tests for concurrent /v1/hosted/activate races in HostedCollection.
// Uses the real Worker ready/sync/activate/alarm methods and pumpLog; only platform,
// WASM and network ports are synthetic, faithfully modeling Replica::open_hosted's
// warm-wake KeyRebuild and logRetire/logBind semantics (hosted.rs, log_session.rs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { encode } from "../../../packages/sdk/src/cbor.ts";
import { cpCustody } from "../src/cp-custody.ts";

const collection = "10000000-0000-4000-8000-000000000001";
const device = "20000000-0000-4000-8000-000000000002";
const token = "s".repeat(40);
const S = 1000;
const start = 1_000_000_000_000;
const frame = (method) => [...encode(new Map([[2, method], [3, new Map()]]))];
const readFrame = frame("read");
const headFrame = frame("subscribe");
const appendFrame = frame("append");

const compiled = await build({
  entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "wake-race-ports",
    setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export class DurableObject {}" }));
      b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "wasm", namespace: "native-module" }));
      b.onLoad({ filter: /.*/, namespace: "native-module" }, () => ({
        contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));",
      }));
      b.onResolve({ filter: /^\.\/engine\.(js|ts)$/ }, () => ({ path: "engine", namespace: "native-port" }));
      b.onLoad({ filter: /.*/, namespace: "native-port" }, () => ({
        contents: `
        const READ = new Uint8Array(${JSON.stringify(readFrame)});
        const HEAD = new Uint8Array(${JSON.stringify(headFrame)});
        const APPEND = new Uint8Array(${JSON.stringify(appendFrame)});
        export class Engine {
          constructor(storage) {
            this.f = storage.fixture;
            this.logBound = false;
            this.nextId = 1;
            this.queued = [];
            this.inflight = new Map();
            // Warm-wake persisted cache: head > 0 starts with KeyRebuild active (hosted.rs:853).
            this.keyRebuild = this.f.cachedHead > 0 ? { reading: false } : null;
            this.applied = this.f.cachedHead;
            this.enrolmentsSeen = 0;
            this.grantsEmitted = 0;
          }
          open() {
            if (this.keyRebuild) this.queueKeyRebuild();
            else this.queueCall("head", HEAD);
          }
          queueKeyRebuild() {
            if (!this.keyRebuild || this.keyRebuild.reading) return;
            this.keyRebuild.reading = true;
            this.queueCall("key_rebuild", READ);
          }
          queueCall(kind, frame) {
            const id = this.nextId++;
            this.queued.push({ id, kind, frame });
          }
          noiseKey() { return false; }
          serving() { return !this.keyRebuild && this.applied >= this.f.logHead; }
          cacheRecovery() { return null; }
          appliedHead() { return String(this.applied); }
          installStatus() { return null; }
          snapshotDeclined() { return false; }
          nextWakeup() { return null; }
          attachmentObject() { return null; }
          poll() { return []; }
          signRpc() { return new Uint8Array(64); }
          logBind() {
            this.logBound = true;
            // LogPush::Reconnected (append.rs:1958): queues head fetch, does NOT resume paused KeyRebuild.
            this.queueCall("head", HEAD);
            return true;
          }
          logRetire() {
            this.logBound = false;
            const lost = [...this.inflight.entries()];
            this.inflight.clear();
            this.queued = [];
            // retire_authenticated_log delivers Err(NoResponse) to all in-flight calls (log_session.rs:167).
            for (const [, kind] of lost) {
              if (kind === "key_rebuild" && this.keyRebuild) {
                // on_key_rebuild (hosted.rs:1335-1339): clears reading and waits for next tick().
                this.keyRebuild.reading = false;
              }
            }
          }
          refresh() { this.logRetire(); }
          tick() {
            // tick_timers (append.rs:1646) resumes paused KeyRebuild.
            if (this.keyRebuild) this.queueKeyRebuild();
          }
          logCalls() {
            const out = this.queued.map(({ id, kind, frame }) => {
              this.inflight.set(id, kind);
              return { id, frame };
            });
            this.queued = [];
            return out;
          }
          logReply(id, bytes) {
            const kind = this.inflight.get(id);
            if (!kind) return;
            this.inflight.delete(id);
            const observedHead = bytes[0] ?? 0;
            if (kind === "key_rebuild") {
              this.keyRebuild = null;
              this.queueCall("head", HEAD);
              return;
            }
            // hosted_blocked() while keyRebuild is active (append.rs:179).
            if (this.keyRebuild) return;
            if (kind === "head") {
              if (observedHead > this.applied) this.queueCall("read_tail", READ);
              return;
            }
            if (kind === "read_tail") {
              this.applied = observedHead;
              if (this.f.pendingEnrolments > this.enrolmentsSeen) {
                this.enrolmentsSeen = this.f.pendingEnrolments;
                this.queueCall("append_grant", APPEND);
              }
              return;
            }
            if (kind === "append_grant") {
              this.grantsEmitted++;
              this.f.grantsEmitted++;
            }
          }
          logFailed(id) {
            const kind = this.inflight.get(id);
            this.inflight.delete(id);
            if (kind === "key_rebuild" && this.keyRebuild) this.keyRebuild.reading = false;
          }
        }`,
      }));
    },
  }],
});

const { HostedCollection } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=wake-race-worker.mjs").toString("base64")}`
);

function activateRequest() {
  return new Request(`https://hosted.test/v1/hosted/activate?collection=${collection}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ collection }),
  });
}

function createFixture({ cachedHead, logHead, pendingEnrolments, onRpc }) {
  const data = new Map([["service-collection", collection]]);
  let alarm = null;
  const f = { cachedHead, logHead, pendingEnrolments, grantsEmitted: 0 };
  const storage = {
    fixture: f,
    get: async (k) => Array.isArray(k) ? new Map(k.filter((x) => data.has(x)).map((x) => [x, data.get(x)])) : data.get(k),
    put: async (k, v) => { data.set(k, v); },
    delete: async (k) => data.delete(k),
    sync: async () => {},
    getAlarm: async () => alarm,
    setAlarm: async (at) => { alarm = at; },
    deleteAlarm: async () => { alarm = null; },
  };
  const bytes = (n) => new Uint8Array(32).fill(n);
  const record = {
    kind: "hosted",
    deviceId: device,
    signPk: bytes(1),
    kemPk: bytes(2),
    noisePk: bytes(3),
    wrappedKeys: new Uint8Array([1]),
    kmsKeyArn: "synthetic",
    genesis: { seq: 1, item: new Uint8Array([1]), hash: bytes(4) },
  };
  const custody = cpCustody({
    kind: "hosted",
    roots: [bytes(5)],
    policyPins: new Uint8Array([1]),
    verifyOriginal: () => true,
    control: {
      serviceDevice: async () => record,
      logToken: async () => ({ token: "synthetic-bearer", expiresAt: Date.now() + 15 * 60 * S }),
    },
    unwrap: async () => new Uint8Array(96).fill(1),
    derive: () => ({ signPk: record.signPk, kemPk: record.kemPk, noisePk: record.noisePk }),
  });
  const o = Object.create(HostedCollection.prototype);
  const physical = { equals: (x) => x === physical };
  Object.assign(o, {
    escrow: false,
    env: { HOSTED_SERVICE_TOKEN: token, COLLECTIONS: { idFromName: () => physical } },
    ctx: { id: physical, storage, getWebSockets: () => [] },
    custody,
    logGen: 0,
    readers: new Map(),
    attachmentWaiters: new Map(),
    staleAppends: { reserve: () => true, settle() {} },
    lastRefresh: 0,
  });
  o.token = () => custody.logToken(collection, new AbortController().signal);
  o.log = () => ({
    fetch: async (url, init) => {
      if (String(url).endsWith("/v1/nonce")) return new Response("ab".repeat(32));
      if (onRpc) await onRpc(init?.body);
      return new Response(new Uint8Array([f.logHead]));
    },
  });
  return { o, f, alarm: () => alarm };
}

test("concurrent /v1/hosted/activate during cold open KeyRebuild does not abort KeyRebuild and delay the grant until REFRESH_MS", async (ctx) => {
  ctx.mock.method(Date, "now", () => start);
  ctx.mock.method(Math, "random", () => 0);

  let releaseFirstRpc;
  const firstRpcStarted = Promise.withResolvers();
  const firstRpcGate = new Promise((resolve) => { releaseFirstRpc = resolve; });
  let rpcCount = 0;

  const { o, f } = createFixture({
    cachedHead: 5,
    logHead: 6,
    pendingEnrolments: 1,
    onRpc: async () => {
      if (++rpcCount === 1) {
        firstRpcStarted.resolve();
        await firstRpcGate;
      }
    },
  });

  // Wake 1 starts a cold open over the persisted cache (head=5 -> KeyRebuild in flight).
  const wake1 = o.fetch(activateRequest());
  await firstRpcStarted.promise;

  // While KeyRebuild is in flight, a second /v1/hosted/activate arrives (e.g., from the 2s poller).
  const wake2 = o.fetch(activateRequest());
  // Yield a few turns so wake2 reaches ready() while wake1's KeyRebuild RPC is still pending.
  for (let i = 0; i < 10; i++) await Promise.resolve();

  releaseFirstRpc();
  const [r1, r2] = await Promise.all([wake1, wake2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  // Without awaiting this.opening in ready(), wake2 retired KeyRebuild and both wakes returned 200
  // with zero grants emitted, leaving the device waiting 30s for alarm() -> tick().
  assert.equal(f.grantsEmitted, 1);
});

test("warm /v1/hosted/activate arriving while an earlier sync is in flight still observes a new enrolment and emits its grant before returning 200", async (ctx) => {
  ctx.mock.method(Date, "now", () => start);
  ctx.mock.method(Math, "random", () => 0);

  let gate = null;
  let gateEntered = null;

  const { o, f } = createFixture({
    cachedHead: 0,
    logHead: 5,
    pendingEnrolments: 0,
    onRpc: async () => {
      if (gate) {
        const currentGate = gate;
        gate = null;
        gateEntered?.resolve();
        await currentGate;
      }
    },
  });

  // Warm the actor at head=5.
  assert.equal((await o.fetch(activateRequest())).status, 200);
  assert.equal(f.grantsEmitted, 0);

  // Start wake 1 for an earlier batch at head=6 (no enrolment yet), pausing its RPC mid-flight.
  f.logHead = 6;
  gateEntered = Promise.withResolvers();
  let releaseWake1Rpc;
  gate = new Promise((resolve) => { releaseWake1Rpc = resolve; });
  const wake1 = o.fetch(activateRequest());
  await gateEntered.promise;

  // While wake 1's RPC is in flight, a new device enrols at head=7 and wake 2 arrives.
  f.logHead = 7;
  f.pendingEnrolments = 1;
  let wake2Done = false;
  const wake2 = o.fetch(activateRequest()).then((res) => { wake2Done = true; return res; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  // Wake 2 must not return 200 early while wake 1's sync is still in flight and no grant has emitted.
  assert.equal(wake2Done, false);
  assert.equal(f.grantsEmitted, 0);

  releaseWake1Rpc();
  const [r1, r2] = await Promise.all([wake1, wake2]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(f.grantsEmitted, 1);
});
