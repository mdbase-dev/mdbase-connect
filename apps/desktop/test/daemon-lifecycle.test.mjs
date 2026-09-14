import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { connectCliEnvironment, daemonCliArguments, parseDaemonPaths, launchDaemon } = createRequire(import.meta.url)("../dist/main/daemon-lifecycle.js");

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

for (const target of ["installed_service", "isolated_profile"]) {
  test(`launch uses the selected binary and exact ${target} profile`, { skip: process.platform === "win32" }, async t => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-launch-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "preserved-cli");
    const report = join(root, "arguments.json");
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    const paths = { stateDir: join(root, "state"), endpoint: join(root, "socket"), target };
    await launchDaemon(binary, paths, true);
    assert.deepEqual(JSON.parse(await readFile(report, "utf8")), daemonCliArguments(target, paths.stateDir, paths.endpoint, ["start"]));
    await assert.rejects(launchDaemon(join(root, "missing"), paths, true), /runtime is missing/);
  });
}
