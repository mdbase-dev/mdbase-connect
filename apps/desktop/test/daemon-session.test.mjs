import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const require = createRequire(import.meta.url);
const { FrameDecoder, encodeFrame } = require("../dist/main/daemon-client.js");
const { DaemonSession } = require("../dist/main/daemon-session.js");

const STATUS = {
  readiness: { schema_version: 1, ready: true, binary_version: "0.0.0", control_protocol: 1 },
  account: { signed_in: true, online: true },
  collections: []
};

/** A control endpoint that counts the connections it currently holds open. */
async function fakeDaemon(onRequest) {
  const dir = await mkdtemp(join(tmpdir(), "mdbn-session-"));
  const path = process.platform === "win32" ? `\\\\.\\pipe\\mdbn-session-${process.pid}-${Date.now()}` : join(dir, "control.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk)) onRequest(request, (frame) => socket.write(frame));
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  return {
    endpoint: { kind: process.platform === "win32" ? "pipe" : "unix", path },
    get open() { return sockets.size; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function session(daemon, ensured = []) {
  return new DaemonSession({
    profile: { target: "installed_service", stateDir: "/unused", control: daemon.endpoint },
    bundled: { binary: "/unused/mdbase", version: "0.0.0" },
    cli: null,
    ensureInstalled: async () => { ensured.push("ensure"); },
    reconnectDelaysMs: [60_000]
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("repeated and concurrent starts keep a single status subscription", async () => {
  const daemon = await fakeDaemon((request, send) => {
    send(encodeFrame({ v: 1, id: request.id, result: request.method === "status.subscribe" ? STATUS : {} }));
  });
  const ensured = [];
  const subject = session(daemon, ensured);
  await Promise.all([subject.start(), subject.start(), subject.start()]);
  // BootGate starts the session again before every daemon-backed IPC request.
  for (let i = 0; i < 5; i += 1) await subject.start();
  await settle();
  assert.equal(daemon.open, 1);
  assert.deepEqual(ensured, ["ensure"]);
  assert.equal(subject.current.phase, "ready");
  subject.stop();
  await daemon.close();
});

test("a subscription that fails is closed instead of being left open", async () => {
  let answer = false;
  const daemon = await fakeDaemon((request, send) => {
    if (request.method !== "status.subscribe") return;
    if (answer) send(encodeFrame({ v: 1, id: request.id, result: STATUS }));
    else send(encodeFrame({ v: 1, id: request.id, error: { code: "unavailable", message: "busy" } }));
  });
  const subject = session(daemon);
  for (let i = 0; i < 3; i += 1) await assert.rejects(subject.start(), (error) => error.code === "unavailable");
  await settle();
  assert.equal(daemon.open, 0);
  answer = true;
  await subject.start();
  await settle();
  assert.equal(daemon.open, 1);
  subject.stop();
  await daemon.close();
});
