import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { guardDesktopProcessOutput } = require("../dist/main/process-output.js");

test("closed launcher output pipes do not crash the desktop process", () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  guardDesktopProcessOutput(stdout, stderr);

  assert.doesNotThrow(() => {
    stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    stderr.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  });
  assert.equal(stdout.listenerCount("error"), 1);
  assert.equal(stderr.listenerCount("error"), 1);
});
