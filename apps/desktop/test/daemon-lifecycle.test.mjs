import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  connectCliEnvironment,
  daemonCliArguments
} = require("../dist/main/daemon-lifecycle.js");

test("packaged daemon commands target the installed service", () => {
  assert.deepEqual(
    daemonCliArguments(
      true,
      "/tmp/isolated-state",
      "/tmp/isolated.sock",
      ["start"]
    ),
    ["connect", "daemon", "start"]
  );
  assert.deepEqual(
    daemonCliArguments(
      true,
      "/tmp/isolated-state",
      "/tmp/isolated.sock",
      ["status"],
      true
    ),
    ["--json", "connect", "daemon", "status"]
  );
});

test("development daemon commands retain their isolated profile", () => {
  assert.deepEqual(
    daemonCliArguments(
      false,
      "/tmp/isolated-state",
      "/tmp/isolated.sock",
      ["start"]
    ),
    [
      "--state-dir",
      "/tmp/isolated-state",
      "--endpoint",
      "/tmp/isolated.sock",
      "connect",
      "daemon",
      "start"
    ]
  );
});

test("packaged CLI calls cannot inherit isolated-profile selectors", () => {
  const environment = {
    PATH: "/usr/bin",
    MDBASE_CONNECT_HOME: "/tmp/isolated-state",
    MDBASE_CONNECT_SOCKET: "/tmp/isolated.sock"
  };
  assert.deepEqual(connectCliEnvironment(true, environment), { PATH: "/usr/bin" });
  assert.equal(connectCliEnvironment(false, environment), environment);
});
