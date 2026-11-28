import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { DirectDaemon } = require("../dist/main/direct-daemon.js");
const { requestDaemon } = require("../dist/main/daemon-client.js");
const { ensureBundledDaemon } = require("../dist/main/next-daemon.js");
const { UpdateStateStore } = require("../dist/main/update-state.js");

test("GUI starts the bundled daemon for the installed profile and waits for its exit on quit", {
  skip: process.platform !== "linux",
  timeout: 15_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mdbase-direct-"));
  const socket = join(root, "control.sock");
  const control = { kind: "unix", path: socket };
  const daemon = new DirectDaemon(control);
  t.after(async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });
  const binary = join(root, "mdbase");
  const started = join(root, "started");
  const stopped = join(root, "stopped");
  const version = "0.2.0";
  const readiness = { ready: true, binary_version: version, control_protocol: 1, schema_version: 1 };
  await writeFile(binary, `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args === "--json service status") {
  console.log(JSON.stringify({ registration: "installed", binary_version: "0.1.0", manager_unavailable: true }));
} else if (args === "daemon run" && process.env.MDBASE_HOME === undefined) {
  const fs = require("node:fs");
  fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
  const server = require("node:net").createServer((client) => {
    client.once("data", (frame) => {
      const { id } = JSON.parse(frame.subarray(4));
      const body = Buffer.from(JSON.stringify({ v: 1, id, result: { readiness: ${JSON.stringify(readiness)} } }));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      client.end(Buffer.concat([header, body]));
    });
  }).listen(${JSON.stringify(socket)});
  process.on("SIGTERM", () => server.close(() => {
    fs.writeFileSync(${JSON.stringify(stopped)}, String(process.pid));
  }));
} else {
  process.exit(2);
}
`);
  await chmod(binary, 0o700);

  const store = new UpdateStateStore(join(root, "update.json"));
  const startDirect = (executable, expected) => daemon.start(executable, expected);
  const { result, holding } = await ensureBundledDaemon(store, { binary, version }, root, startDirect);
  assert.deepEqual(result, { outcome: "started_direct", version });
  assert.equal(holding, false);
  assert.deepEqual(await requestDaemon(control, "ping"), { readiness });
  await daemon.stop();
  assert.equal(await readFile(stopped, "utf8"), await readFile(started, "utf8"));
});
