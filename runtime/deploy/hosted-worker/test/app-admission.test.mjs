// App socket admission on the real Durable Object methods (platform and WASM
// imports replaced, a fake engine): sockets that never complete hello cannot hold
// the per-DO caps against a client that does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { MAX_APP_SESSIONS, MAX_APP_SOCKETS, PROLOGUE_TAG, uuidBytes } from "../src/app.ts";

const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const device = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
const grant = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "hosted.wasm", namespace: "synthetic-wasm" }));
    b.onLoad({ filter: /hosted\.wasm$/ }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
  },
}] });
const { HostedCollection } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=app-admission-worker.mjs").toString("base64")}`);

class Socket {
  constructor(attachment = null) { this.attachment = attachment; this.closed = null; this.sent = []; this.readyState = 1; }
  deserializeAttachment() { return this.attachment; }
  serializeAttachment(a) { this.attachment = a; }
  send(b) { this.sent.push(b); }
  close(code, reason) { this.closed = [code, reason]; this.readyState = 3; }
}

function actor() {
  let handles = 0, sessions = 0;
  const engine = {
    noiseStart: () => ++handles, noiseDrop() {}, close() {}, refresh() {},
    noiseRead1: () => ({ peer: new Uint8Array(32).fill(7), payload: new Uint8Array(4) }),
    hello: () => ({ session: ++sessions, response: new Uint8Array(4) }),
    noiseWrite2: () => new Uint8Array(8),
  };
  const sockets = [];
  const o = Object.create(HostedCollection.prototype);
  Object.assign(o, {
    escrow: false, collection, wakeId: "wake-1", engine, lastRefresh: Date.now(), readers: new Map(), attachmentWaiters: new Map(),
    live: { engine, device, admission: { recheck: () => "allow" } },
    ctx: { getWebSockets: () => sockets.filter((s) => s.readyState === 1), acceptWebSocket: (ws) => sockets.push(ws) },
    env: {},
  });
  o.ready = async () => engine;
  o.sync = async () => {};
  return { o, engine, sockets };
}

const prologue = () => {
  const p = new Uint8Array(64);
  p.set(PROLOGUE_TAG, 0); p.set(uuidBytes(collection), 16); p.set(uuidBytes(grant), 32); p.set(uuidBytes(device), 48);
  return p.buffer;
};

/** Open an app socket through the real fetch path. */
async function open(o) {
  const saved = { Response: globalThis.Response, WebSocketPair: globalThis.WebSocketPair };
  globalThis.WebSocketPair = class { constructor() { this[0] = new Socket(); this[1] = new Socket(); } };
  globalThis.Response = class { constructor(body, init) { this.body = body; this.status = init?.status; } };
  try {
    return await o.fetch(new Request(`https://hosted/v1/hosted/app?collection=${collection}`, { headers: { upgrade: "websocket" } }));
  } finally { Object.assign(globalThis, saved); }
}

const open$ = (sockets) => sockets.filter((s) => s.readyState === 1);

test("sockets that never send a prologue cannot fill the socket cap", async () => {
  const { o, sockets } = actor();
  for (let i = 0; i < MAX_APP_SOCKETS; i++) assert.equal((await open(o)).status, 101);
  const first = sockets[0];
  const response = await open(o);
  assert.equal(response.status, 101, "a new client is still admitted at the cap");
  assert.deepEqual(first.closed, [1013, "busy"], "the oldest unauthenticated socket made room");
  assert.equal(open$(sockets).length, MAX_APP_SOCKETS);
});

test("sockets that stop after the prologue cannot hold out a client's hello", async () => {
  const { o, sockets } = actor();
  for (let i = 0; i < MAX_APP_SESSIONS; i++) {
    await open(o);
    await o.webSocketMessage(sockets.at(-1), prologue());
  }
  assert.equal(open$(sockets).length, MAX_APP_SESSIONS, "no prologue was refused");
  await open(o);
  const client = sockets.at(-1);
  await o.webSocketMessage(client, prologue());
  await o.webSocketMessage(client, new Uint8Array(48).buffer);
  assert.equal(client.closed, null);
  assert.equal(typeof client.attachment.session, "number", "hello admitted");
});

test("sessions are capped at hello, and eviction never takes a session", async () => {
  const { o, sockets } = actor();
  const hello = async () => {
    await open(o);
    const ws = sockets.at(-1);
    await o.webSocketMessage(ws, prologue());
    await o.webSocketMessage(ws, new Uint8Array(48).buffer);
    return ws;
  };
  for (let i = 0; i < MAX_APP_SESSIONS; i++) assert.equal((await hello()).closed, null);
  assert.deepEqual((await hello()).closed, [1013, "busy"], "one session over the cap");
  while (open$(sockets).length < MAX_APP_SOCKETS) await open(o);
  await open(o);
  const live = open$(sockets).filter((s) => s.attachment.session !== undefined);
  assert.equal(live.length, MAX_APP_SESSIONS, "every session survived the eviction");
  assert.equal(open$(sockets).length, MAX_APP_SOCKETS);
});

test("a socket from an earlier wake is evicted without touching this engine", async () => {
  const { o, engine, sockets } = actor();
  const dropped = [];
  engine.noiseDrop = (h) => dropped.push(h);
  sockets.push(new Socket({ wake: "wake-0", app: true, opened: 0, noise: 1, session: 1 }));
  for (let i = 1; i < MAX_APP_SOCKETS; i++) await open(o);
  await open(o);
  assert.deepEqual(sockets[0].closed, [1012, "rehandshake"]);
  assert.deepEqual(dropped, []);
});
