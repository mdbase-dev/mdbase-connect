import { test } from "vitest";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { parseStat, ownedTree, verifyStopped } from "./cleanup.mjs";

test("stat parser handles spaces/parentheses and captures field22, not PID alone", () => {
  const fields = ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1)), "123456", "0"];
  assert.deepEqual(parseStat(`900 (electron (child)) ${fields.join(" ")}`), { state: "S", start: "123456" });
  assert.equal(parseStat("not stat"), null);
});
test("own process tree is captured without reading command lines", async () => {
  const tree = await ownedTree(process.pid);
  assert.equal(tree[0].pid, process.pid);
  assert.match(tree[0].start, /^[0-9]+$/);
});
test("captures children launched from a non-leader thread", async () => {
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    parentPort.postMessage(child.pid);`, { eval: true });
  let pid;
  try {
    pid = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    const tree = await ownedTree(process.pid);
    assert.ok(tree.some(entry => entry.pid === pid));
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await worker.terminate();
  }
});
test("cleanup cannot report a live owned process as stopped", async () => {
  const tree = await ownedTree(process.pid);
  assert.equal(await verifyStopped(tree, 9372, 1), false);
});
