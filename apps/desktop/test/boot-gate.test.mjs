import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { BootGate } = createRequire(import.meta.url)("../dist/main/boot-gate.js");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("all IPC waits for one recovery and one concurrent startup", async () => {
  const recovery = deferred();
  const start = deferred();
  const events = [];
  const gate = new BootGate({
    async initialize() { events.push("recover"); await recovery.promise; },
    async start() { events.push("start"); await start.promise; },
    blockedReason: () => null
  });
  const requests = [1, 2, 3].map((id) => gate.request(async () => events.push(id)));
  assert.deepEqual(events, ["recover"]);
  recovery.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(events, ["recover", "start"]);
  start.resolve();
  await Promise.all(requests);
  assert.deepEqual(events, ["recover", "start", 1, 2, 3]);
});

test("update checks cannot race persisted recovery or start a daemon", async () => {
  const recovery = deferred();
  let blocked = null;
  let checks = 0;
  const gate = new BootGate({
    async initialize() { await recovery.promise; },
    async start() { assert.fail("checking updates must not require daemon startup"); },
    blockedReason: () => blocked
  });
  const checking = gate.check(async () => ++checks);
  await new Promise(setImmediate);
  assert.equal(checks, 0);
  recovery.resolve();
  assert.equal(await checking, 1);
  blocked = "recovery failed";
  await assert.rejects(gate.check(async () => assert.fail()), /recovery failed/);
});

test("failed boot stays closed to later IPC without replaying initialization", async () => {
  let attempts = 0;
  const gate = new BootGate({
    async initialize() { attempts++; throw new Error("rollback failed"); },
    async start() { assert.fail("must not start"); },
    blockedReason: () => null
  });
  for (let i = 0; i < 3; i++) await assert.rejects(gate.request(async () => assert.fail()), /rollback failed/);
  await assert.rejects(gate.check(async () => assert.fail()), /rollback failed/);
  assert.equal(attempts, 1);
});

test("install waits for admitted startup and blocks racing IPC", async () => {
  const start = deferred();
  const install = deferred();
  let blocked = null;
  let installed = false;
  const gate = new BootGate({
    async initialize() {},
    async start() { await start.promise; },
    blockedReason: () => blocked
  });
  const request = gate.request(async () => assert.fail("must not send after install admission"));
  const rejected = assert.rejects(request, /update is in progress/);
  await new Promise(setImmediate);
  const installing = gate.install(async () => {
    installed = true;
    await install.promise;
    blocked = "recovery failed";
    throw new Error("install failed");
  });
  await new Promise(setImmediate);
  assert.equal(installed, false);
  await assert.rejects(gate.request(async () => assert.fail()), /update is in progress/);
  await assert.rejects(gate.install(async () => assert.fail()), /update is in progress/);
  await assert.rejects(gate.check(async () => assert.fail()), /update is in progress/);
  start.resolve();
  await rejected;
  await new Promise(setImmediate);
  assert.equal(installed, true);
  const failed = assert.rejects(installing, /install failed/);
  install.resolve();
  await failed;
  await assert.rejects(gate.ready(), /recovery failed/);
});

test("verified recovery after failed installation permits ordinary IPC", async () => {
  const gate = new BootGate({ async initialize() {}, async start() {}, blockedReason: () => null });
  await assert.rejects(gate.install(async () => { throw new Error("restored old runtime"); }), /restored/);
  assert.equal(await gate.request(async () => "ok"), "ok");
});
