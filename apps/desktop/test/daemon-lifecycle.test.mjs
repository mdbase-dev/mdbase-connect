import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { connectCliEnvironment, daemonCliArguments, parseDaemonPaths } = createRequire(import.meta.url)("../dist/main/daemon-lifecycle.js");

test("default daemon commands preserve CLI service targeting without inferred overrides", () => {
  const paths = parseDaemonPaths({ state_dir: "/default/state", endpoint: "/default/socket", target: "installed_service" });
  assert.deepEqual(daemonCliArguments(paths.target, paths.stateDir, paths.endpoint, ["start"]), ["connect", "daemon", "start"]);
  assert.deepEqual(daemonCliArguments(paths.target, paths.stateDir, paths.endpoint, ["status"], true), ["--json", "connect", "daemon", "status"]);
});

test("explicit isolated profile never controls the default installed service", () => {
  const paths = parseDaemonPaths({ state_dir: "/isolated/state", endpoint: "/isolated/socket", target: "isolated_profile" });
  for (const command of ["start", "stop", "status"]) {
    assert.deepEqual(daemonCliArguments(paths.target, paths.stateDir, paths.endpoint, [command]), [
      "--state-dir", "/isolated/state", "--endpoint", "/isolated/socket", "connect", "daemon", command
    ]);
  }
});

test("missing or unknown profile information cannot silently select a lifecycle owner", () => {
  for (const target of [undefined, "detached", "unknown"]) {
    assert.throws(() => parseDaemonPaths({ state_dir: "/state", endpoint: "/socket", target }), /invalid path/);
  }
});

test("packaged CLI calls cannot inherit isolated-profile selectors", () => {
  const environment = { PATH: "/usr/bin", MDBASE_CONNECT_HOME: "/isolated/state", MDBASE_CONNECT_SOCKET: "/isolated/socket" };
  assert.deepEqual(connectCliEnvironment(true, environment), { PATH: "/usr/bin" });
  assert.equal(connectCliEnvironment(false, environment), environment);
});
