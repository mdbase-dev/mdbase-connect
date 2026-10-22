import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { stopOwnedChild } from "./app-owned-child-stop.mjs";

class Child extends EventEmitter {
  exitCode = null;
  signalCode = null;
  signals = [];
  onSignal = () => {};
  kill(signal) { this.signals.push(signal); this.onSignal(signal); return true; }
  exit(signal) { this.signalCode = signal; this.emit("exit", null, signal); }
}
test("already stopped or absent child is not signalled", async () => {
  await stopOwnedChild(undefined);
  const child = new Child(); child.exitCode = 0;
  await stopOwnedChild(child); assert.deepEqual(child.signals, []);
});
test("TERM success requires an actual exit", async () => {
  const child = new Child(); child.onSignal = signal => child.exit(signal);
  await stopOwnedChild(child, 10); assert.deepEqual(child.signals, ["SIGTERM"]);
});
test("KILL request alone never certifies cleanup", async () => {
  const child = new Child();
  await assert.rejects(stopOwnedChild(child, 5), /cleanup unconfirmed/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("exit"), 0);
});
test("KILL waits for the matching child's exit", async () => {
  const child = new Child();
  child.onSignal = signal => { if (signal === "SIGKILL") setTimeout(() => child.exit(signal), 1); };
  await stopOwnedChild(child, 10); assert.equal(child.signalCode, "SIGKILL");
});
test("real owned child has exited before return", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  await stopOwnedChild(child, 1000);
  assert(child.exitCode !== null || child.signalCode !== null);
});
