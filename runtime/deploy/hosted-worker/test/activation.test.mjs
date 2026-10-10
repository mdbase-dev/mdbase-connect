import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { serviceCollection } from "../src/service-devices.ts";

const token = "s".repeat(40);
const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const post = (body = { collection }, auth = `Bearer ${token}`) => new Request("https://hosted.test/internal/v1/collections/activate", {
  method: "POST", headers: { authorization: auth }, body: JSON.stringify(body),
});

// Exercise the real Worker routing/alarm methods with only platform/WASM imports
// replaced. No credentials, SQL, network or app admission are bypassed in product.
const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "platform-test", setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fake" }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({ contents: "export class DurableObject {}" }));
    b.onLoad({ filter: /hosted\.wasm$/ }, () => ({ contents: "export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" }));
  },
}] });
const { HostedCollection, default: worker } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
function object(escrow = false) {
  const data = new Map(); let alarm;
  const storage = { get: async (k) => Array.isArray(k) ? new Map(k.filter(key => data.has(key)).map(key => [key, data.get(key)])) : data.get(k), put: async (k, v) => data.set(k, v), getAlarm: async () => alarm ?? null, setAlarm: async (at) => { alarm = at; } };
  const o = Object.create(HostedCollection.prototype);
  Object.assign(o, { escrow, ctx: { storage, getWebSockets: () => [] }, env: { HOSTED_SERVICE_TOKEN: token }, logGen: 0, readers: new Map(), staleAppends: {}, lastRefresh: 0 });
  return { o, data, alarm: () => alarm };
}
test("activation request is authenticated and bounded without requiring WASM", async () => {
  assert.equal(await serviceCollection(post(), token), collection);
  assert.equal((await serviceCollection(post({}, "Bearer wrong"), token)).status, 401);
  assert.equal((await serviceCollection(post(), undefined)).status, 401);
  for (const body of [{}, { collection, extra: 1 }, { collection: "invalid" }, { collection: "x".repeat(2000) }]) {
    assert.equal((await serviceCollection(post(body), token)).status, 400);
  }
});
test("CP activation routes only the exact authenticated collection and is repeatable", async () => {
  const seen = []; const env = { HOSTED_SERVICE_TOKEN: token, COLLECTIONS: {
    idFromName(id) { assert.equal(id, collection); return id; },
    get() { return { async fetch(request) { seen.push(request); return Response.json({ activated: true }); } }; },
  } };
  for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(post(), env)).status, 200);
  for (const request of seen) {
    assert.equal(new URL(request.url).pathname, "/v1/hosted/activate");
    assert.equal(new URL(request.url).searchParams.get("collection"), collection);
    assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
    assert.deepEqual(await request.json(), { collection });
  }
  assert.equal((await worker.fetch(post({}, "Bearer wrong"), env)).status, 401);
  assert.equal(seen.length, 2);
});
test("both service roles persist reopen identity and an alarm before failed custody", async () => {
  for (const escrow of [false, true]) {
    const { o, data, alarm } = object(escrow);
    o.custody = { async openSealer() { throw new Error("offline"); } };
    await assert.rejects(o.ready(collection), /offline/);
    assert.equal(data.get("service-collection"), collection);
    assert.ok(alarm() > Date.now());
    assert.equal(o.opening, null);
  }
});
test("failed cold reopen cannot push an existing alarm into the future", async () => {
  for (const escrow of [false,true]) {
    const { o, alarm } = object(escrow);
    const early = Date.now()+5_000;
    await o.ctx.storage.setAlarm(early);
    o.custody = { async openSealer() { throw new Error("offline"); } };
    await assert.rejects(o.ready(collection), /offline/);
    assert.equal(alarm(),early);
  }
});
test("socket-free hosted and escrow alarms reopen, refresh and reschedule", async () => {
  for (const escrow of [false, true]) {
    const { o, data, alarm } = object(escrow); data.set("service-collection", collection);
    const calls = []; const engine = { tick() { calls.push("tick"); }, refresh() { calls.push("refresh"); }, nextWakeup() { return null; } };
    o.ready = async (id) => { assert.equal(id, collection); calls.push("reopen"); o.collection = id; o.engine = engine; return engine; };
    o.sync = async () => { calls.push("sync"); await o.ctx.storage.setAlarm(Date.now() + 30_000); };
    await o.alarm();
    assert.deepEqual(calls, ["reopen", "tick", "refresh", "sync"]);
    assert.ok(alarm() > Date.now());
  }
});
test("real sync schedules polling for both roles with zero client sockets", async () => {
  for (const escrow of [false, true]) {
    const { o, alarm } = object(escrow);
    const engine = { logBound: true, logCalls: () => [], poll: () => [], nextWakeup: () => null, attachmentObject: () => null };
    o.engine = engine; o.log = () => ({});
    const before = Date.now();
    await o.sync(engine);
    assert.ok(alarm() >= before + (escrow ? 60_000 : 30_000));
  }
});
test("traffic does not slide the existing socket-free polling deadline", async () => {
  for (const escrow of [false, true]) {
    const { o, alarm } = object(escrow);
    const engine = { logBound: true, logCalls: () => [], poll: () => [], nextWakeup: () => null, attachmentObject: () => null };
    o.engine = engine; o.log = () => ({});
    const early = Date.now() + 5_000;
    await o.ctx.storage.setAlarm(early);
    for (let i = 0; i < 5; i++) await o.sync(engine);
    assert.equal(alarm(), early, "RPC traffic must not postpone the head refresh");
  }
});
test("stale engine cannot reschedule after awaiting the persisted alarm", async () => {
  const { o, alarm } = object();
  const engine = { logBound: true, logCalls: () => [], poll: () => [], nextWakeup: () => null, attachmentObject: () => null };
  o.engine = engine; o.log = () => ({});
  o.ctx.storage.getAlarm = async () => { o.logGen++; return null; };
  await o.sync(engine);
  assert.equal(alarm(), undefined);
});
test("existing escrow collection key still reopens", async () => {
  const { o, data } = object(true); data.set("escrow-collection", collection);
  o.ready = async (id) => { assert.equal(id, collection); o.collection = id; o.engine = { tick() {}, refresh() {} }; };
  o.sync = async () => {};
  await o.alarm();
});

// Resource/generation orchestration only; actual native READ denial/error
// precedence is separately exercised by signed engine lifecycle tests.
function readerObject() {
  const {o}=object();let calls=0,busy=0,closed=0,active=false;
  const engine={attachmentCallRequiresSlot:()=>true,frame(){calls++;active=true;},attachmentCallBusy(){busy++;},attachmentActive:()=>active,close(){closed++;active=false;}};
  Object.assign(o,{engine,attachmentPermit:null,attachmentWaiters:new Map(),attachmentAdmitted:()=>true});
  return {o,engine,counts:()=>({calls,busy,closed})};
}
test("one isolate read slot spans DOs; overflow is native typed busy, not a fetch",async()=>{
 const a=readerObject(),b=readerObject(),c=readerObject(),frame=Uint8Array.of(1);
 try {
  await a.o.attachmentFrame(a.engine,1,frame);
  const pending=b.o.attachmentFrame(b.engine,2,frame);
  await c.o.attachmentFrame(c.engine,3,frame);
  assert.equal(c.counts().busy,1);assert.equal(c.counts().calls,0);assert.equal(b.counts().calls,0);
  a.o.releaseAttachment(a.engine,1);await pending;assert.equal(b.counts().calls,1);
 } finally {a.o.releaseAttachment(a.engine);b.o.releaseAttachment(b.engine);c.o.releaseAttachment(c.engine);}
});
test("queued call cannot act after generation changed; acquired slot is released",async()=>{
 const a=readerObject(),b=readerObject(),frame=Uint8Array.of(1);
 try {
  await a.o.attachmentFrame(a.engine,1,frame);
  const pending=b.o.attachmentFrame(b.engine,2,frame);b.o.logGen++;
  a.o.releaseAttachment(a.engine,1);await pending;
  assert.equal(b.counts().calls,0);assert.equal(b.counts().closed,1);
  await a.o.attachmentFrame(a.engine,1,frame);assert.equal(a.counts().calls,2);
 } finally {a.o.releaseAttachment(a.engine);b.o.releaseAttachment(b.engine);}
});
test("completed attachment releases its slot without closing the app session",async()=>{
 const {o,engine,counts}=readerObject();
 await o.attachmentFrame(engine,1,Uint8Array.of(1));
 engine.attachmentActive=()=>false;o.pruneAttachment();
 assert.equal(counts().closed,0);assert.equal(o.attachmentPermit,null);
});
test("EOF does not cancel a queued call on the still-live same session",async()=>{
 const {o,engine,counts}=readerObject();
 try {
  await o.attachmentFrame(engine,1,Uint8Array.of(1));
  const pending=o.attachmentFrame(engine,1,Uint8Array.of(1));
  engine.attachmentActive=()=>false;o.pruneAttachment();await pending;
  assert.equal(counts().calls,2);assert.equal(counts().closed,0);assert.equal(counts().busy,0);
 } finally {o.releaseAttachment(engine);}
});
