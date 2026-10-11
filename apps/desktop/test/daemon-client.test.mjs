import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const { DaemonConnection, FrameDecoder, encodeFrame, MAX_FRAME_BYTES } =
  createRequire(import.meta.url)("../dist/main/daemon-client.js");

async function fakeDaemon(onRequest) {
  const dir = await mkdtemp(join(tmpdir(), "mdbn-client-"));
  const path = process.platform === "win32" ? `\\\\.\\pipe\\mdbn-client-${process.pid}-${Date.now()}` : join(dir, "control.sock");
  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk)) onRequest(request, (frame) => socket.write(frame));
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  return {
    endpoint: { kind: process.platform === "win32" ? "pipe" : "unix", path },
    async close() { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
  };
}

test("v1 frames: results, typed errors and pushes are routed by request ID", async () => {
  const daemon = await fakeDaemon((request, send) => {
    assert.equal(request.v, 1);
    if (request.method === "status.subscribe") {
      send(encodeFrame({ v: 1, id: request.id, result: {} }));
      send(encodeFrame({ v: 1, push: "status", payload: { ready: true } }));
    } else if (request.method === "collection.remove") {
      send(encodeFrame({ v: 1, id: request.id, error: { code: "not_found", message: "no such collection", reason: "unknown_collection" } }));
    } else {
      // Answer out of order: a later request must not receive an earlier result.
      setTimeout(() => send(encodeFrame({ v: 1, id: request.id, result: { method: request.method } })), request.id === 1 ? 30 : 0);
    }
  });
  const connection = await DaemonConnection.connect(daemon.endpoint);
  const pushes = [];
  connection.onPush((type, payload) => pushes.push([type, payload]));
  const [first, second] = await Promise.all([connection.request("ping"), connection.request("status")]);
  assert.deepEqual([first.method, second.method], ["ping", "status"]);
  await assert.rejects(connection.request("collection.remove", { collection: "x" }),
    (error) => error.code === "not_found" && error.reason === "unknown_collection");
  await connection.request("status.subscribe");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushes, [["status", { ready: true }]]);
  connection.close();
  await daemon.close();
});

test("an oversized frame fails pending requests instead of buffering without bound", async () => {
  const daemon = await fakeDaemon((_request, send) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    send(header);
  });
  const connection = await DaemonConnection.connect(daemon.endpoint);
  await assert.rejects(connection.request("status"), (error) => error.code === "protocol");
  assert.equal(connection.isClosed, true);
  await daemon.close();
});
