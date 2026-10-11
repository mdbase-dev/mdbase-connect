import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const { DaemonCli } = createRequire(import.meta.url)("../dist/main/daemon-cli.js");

test("privileged CLI calls target the chosen profile and surface the daemon's typed error", async () => {
  const calls = [];
  const exec = async (binary, args, env) => {
    calls.push({ binary, args, home: env.MDBASE_HOME });
    if (args.includes("paths")) {
      return { exitCode: 0, value: { target: args.includes("--state-dir") ? "isolated_profile" : "installed_service",
        state_dir: "/s", control: { kind: "unix", path: "/s/run/control.sock" } } };
    }
    return { exitCode: 1, value: { error: { code: "unavailable", message: "gate closed", reason: "rollout_closed" } } };
  };
  const environment = { MDBASE_HOME: "/elsewhere" };
  const installed = await DaemonCli.discover("mdbase", null, exec, environment);
  assert.equal(installed.target, "installed_service");
  assert.equal(calls[0].home, undefined, "the installed profile never inherits MDBASE_HOME");
  const isolated = await DaemonCli.discover("mdbase", "/s", exec, environment);
  assert.equal(isolated.control.path, "/s/run/control.sock");
  const cli = new DaemonCli(() => "mdbase", "isolated_profile", "/s", exec, environment);
  await assert.rejects(cli.run(["migrate", "start"]), (error) => error.reason === "rollout_closed");
  assert.deepEqual(calls.at(-1).args, ["--state-dir", "/s", "--json", "migrate", "start"]);
});
