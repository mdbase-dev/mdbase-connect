import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { ElectronUpdateBackend } = require("../dist/main/electron-update-backend.js");
const { UpdateCoordinator } = require("../dist/main/update-coordinator.js");
const { UpdateStateStore } = require("../dist/main/update-state.js");
const { BootGate } = require("../dist/main/boot-gate.js");
const { ensureAgentReady } = require("../dist/main/agent-startup.js");
const LOCAL_CONTROL_PROTOCOL_VERSION = 5; // Native lifecycle fixture, like rollback-admission.test.mjs.
const previous = "0.1.0-beta.106";
const current = "0.1.0-beta.107";

// External package replacement creates no Electron updater transaction. Exercise
// the existing production boot/reconciliation path; only the OS process boundary
// is simulated. This does not replace native AppX/Task Scheduler acceptance.
for (const mode of ["old-running", "old-stopped", "missing-service", "already-current", "install-failed"]) {
  test(`Store replacement reconciles before IPC: ${mode}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "mdbase-store-startup-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const state = new UpdateStateStore(join(directory, "updates.json"));
    const runtime = {
      installed: mode !== "missing-service",
      running: mode !== "old-stopped",
      version: mode === "already-current" ? current : previous
    };
    const commands = [];
    const binary = join(directory, "WindowsApps", "new-version", "mdbase.exe");
    const backend = new ElectronUpdateBackend({ currentVersion: current, packaged: true,
      platform: "win32", arch: "x64", userDataDirectory: directory,
      binaryPath: () => binary, stateDirectory: () => directory,
      target: () => "installed_service", endpoint: () => "\\\\.\\pipe\\fixture" });
    const readiness = () => ({ schema_version: 1, ready: runtime.running, binary_version: runtime.version });
    backend.runCli = async (file, command) => {
      assert.equal(file, binary);
      commands.push(command[0]);
      if (command[0] === "stop") runtime.running = false;
      if (command[0] === "install") {
        if (mode === "install-failed") throw new Error("Cannot replace service runtime");
        Object.assign(runtime, { installed: true, running: true, version: current });
      }
      return { installed: runtime.installed, running: runtime.running,
        status: { binary_version: runtime.version, protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
          readiness: readiness() } };
    };
    const coordinator = new UpdateCoordinator(state, backend);
    const gate = new BootGate({
      initialize: async () => { await coordinator.initialize(); },
      blockedReason: () => coordinator.daemonStartupBlock(),
      start: () => ensureAgentReady({ expectedVersion: current,
        ping: async () => ({ pong: runtime.running, readiness: readiness() }),
        launch: async () => assert.fail("Reconciliation should already have started the service"),
        endpointIsUnavailable: () => false, incompatibleDaemon: () => false })
    });
    if (mode === "install-failed") {
      await assert.rejects(gate.request(async () => assert.fail("IPC admitted despite failed reconciliation")), /Could not reconcile/);
      assert.equal(coordinator.status().can_check, false);
    } else {
      assert.equal(await gate.request(async () => runtime.version), current);
      assert.equal(commands.includes("install"), mode !== "already-current");
      assert.equal(commands.includes("stop"), ["old-running", "missing-service"].includes(mode));
      assert.equal(coordinator.daemonStartupBlock(), null);
    }
    assert.equal((await state.load()).transaction, undefined);
  });
}
