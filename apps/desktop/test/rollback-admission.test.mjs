import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);
const { UpdateCoordinator } = require("../dist/main/update-coordinator.js");
const { UpdateStateStore, parsePersistedState } = require("../dist/main/update-state.js");
const { ElectronUpdateBackend } = require("../dist/main/electron-update-backend.js");
const { BootGate } = require("../dist/main/boot-gate.js");
const { ensureAgentReady } = require("../dist/main/agent-startup.js");
const previousVersion = "0.1.0-beta.98";
const currentVersion = "0.1.0-beta.99";
const nextVersion = "0.1.0-beta.100";
const nextRelease = { manifest: {
  version: nextVersion, tag: `v${nextVersion}`, channel: "beta", published_at: new Date().toISOString(),
  release_url: "https://example.com/release", rollout: { percentage: 100, seed: "next" }, blocked_versions: [],
  targets: { "darwin-arm64": { mode: "automatic", action_url: "https://example.com/release", artifacts: [] } }
} };

async function fixture(t, failTarget = true) {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-rollback-admission-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "bundled-mdbase");
  const previous = join(directory, "updates", "runtimes", previousVersion, "mdbase");
  await mkdir(dirname(previous), { recursive: true });
  await writeFile(previous, "preserved previous runtime");
  await writeFile(binary, "new bundled runtime");
  const path = join(directory, "state.json");
  const store = new UpdateStateStore(path);
  const transaction = { id: "exact-update", phase: "installing", previous_version: previousVersion,
    target_version: currentVersion, service_installed: true, previous_runtime: previous,
    started_at: new Date().toISOString() };
  await store.update(state => { state.transaction = transaction; });
  const process = { running: false, version: previousVersion, protocol: 5, schema: 1, ready: true, failTarget };
  const commands = [];
  function backend(version = currentVersion) {
    const result = new ElectronUpdateBackend({ currentVersion: version, packaged: true,
      platform: "darwin", arch: "arm64", userDataDirectory: directory,
      binaryPath: () => binary, stateDirectory: () => directory,
      target: () => "installed_service", endpoint: () => join(directory, "control.sock") });
    // Only the native process boundary is simulated. Recovery, reconciliation,
    // persisted state, version checks and gate admission are production code.
    result.runCli = async (file, command) => {
      commands.push([file, command[0]]);
      if (command[0] === "stop") process.running = false;
      if (command[0] === "install") {
        if (file === binary && process.failTarget) throw new Error("New runtime could not start");
        process.running = true;
        process.version = file === previous ? previousVersion : version;
      }
      return { installed: true, running: process.running,
        status: { protocol_version: process.protocol, binary_version: process.version,
          readiness: { schema_version: process.schema, ready: process.ready, binary_version: process.version } } };
    };
    return result;
  }
  function gate(coordinator) {
    return new BootGate({
      initialize: async () => { await coordinator.initialize(); },
      blockedReason: () => coordinator.daemonStartupBlock(),
      start: () => ensureAgentReady({
        expectedVersion: coordinator.daemonStartupRuntime().version,
        async ping() {
          if (!process.running) throw new Error("Unavailable");
          return { pong: true, readiness: {
            schema_version: process.schema, ready: process.ready, binary_version: process.version } };
        },
        async launch() {
          const selected = coordinator.daemonStartupRuntime();
          assert.equal(selected.binary, previous);
          process.running = true;
          process.version = previousVersion;
        },
        endpointIsUnavailable: error => error.message === "Unavailable",
        incompatibleDaemon: () => false
      })
    });
  }
  return { store, path, transaction, previous, binary, process, commands, backend, gate };
}

for (const rollback of [false, true]) {
  test(`verified ${rollback ? "rollback" : "target"} admits ordinary IPC and survives fresh startup`, async t => {
    const f = await fixture(t, rollback);
    const coordinator = new UpdateCoordinator(f.store, f.backend());
    assert.equal(await f.gate(coordinator).request(async () => "admitted"), "admitted");
    assert.equal((await f.store.load()).transaction, undefined);
    assert.deepEqual(coordinator.daemonStartupRuntime(), rollback
      ? { version: previousVersion, binary: f.previous } : { version: currentVersion, binary: null });
    const cold = new UpdateCoordinator(new UpdateStateStore(f.path), f.backend());
    f.commands.length = 0;
    const gate = f.gate(cold);
    await gate.request(async () => {});
    assert.equal(f.commands.some(([, command]) => command === "install"), false);
    assert.equal(f.process.version, rollback ? previousVersion : currentVersion);
    if (rollback) {
      // A later crash must launch the preserved CLI, not the failing new bundle.
      f.process.running = false;
      await gate.request(async () => {});
      assert.equal(f.process.version, previousVersion);
      f.process.version = "0.1.0-beta.97";
      await assert.rejects(gate.request(async () => assert.fail("Unexpected IPC")), /Update or restart/);
    }
  });
}

test("a stopped saved rollback is reconciled using only its preserved binary", async t => {
  const f = await fixture(t);
  await f.gate(new UpdateCoordinator(f.store, f.backend())).ready();
  f.process.running = false;
  f.commands.length = 0;
  await f.gate(new UpdateCoordinator(new UpdateStateStore(f.path), f.backend())).ready();
  assert.ok(f.commands.some(([file, command]) => file === f.previous && command === "install"));
  assert.equal(f.commands.some(([file]) => file === f.binary), false);
});

for (const failure of ["unhealthy", "protocol", "unknown-schema", "missing", "outside"]) {
  test(`a ${failure} saved rollback blocks IPC without silently installing the new bundle`, async t => {
    const f = await fixture(t);
    await f.gate(new UpdateCoordinator(f.store, f.backend())).ready();
    if (failure === "unhealthy") f.process.ready = false;
    if (failure === "protocol") f.process.protocol = 3;
    if (failure === "unknown-schema") f.process.schema = 2;
    if (failure === "missing") await rm(f.previous);
    if (failure === "outside") await f.store.update(s => { s.last_known_good_runtime.path = f.binary; });
    f.commands.length = 0;
    const cold = new UpdateCoordinator(new UpdateStateStore(f.path), f.backend());
    await assert.rejects(f.gate(cold).request(async () => assert.fail("Unexpected IPC")), /Could not reconcile/);
    assert.equal(f.commands.some(([, command]) => command === "install"), false);
    assert.equal(cold.status().can_check, false);
  });
}

test("a newer app does not inherit another app version's selected fallback", async t => {
  const f = await fixture(t, false);
  await f.store.update(s => {
    delete s.transaction;
    s.last_known_good_runtime = { version: previousVersion, path: f.previous, for_app_version: currentVersion };
  });
  const coordinator = new UpdateCoordinator(f.store, f.backend(nextVersion));
  await f.gate(coordinator).ready();
  assert.equal(f.process.version, nextVersion);
  assert.deepEqual(coordinator.daemonStartupRuntime(), { version: nextVersion, binary: null });
});

test("the next update preserves the selected fallback through stage and install failures", async t => {
  const f = await fixture(t);
  const native = f.backend();
  const coordinator = new UpdateCoordinator(f.store, native);
  await f.gate(coordinator).ready();
  native.findLatest = async () => nextRelease;
  native.stageAutomatic = async () => { throw new Error("Download interrupted"); };
  assert.equal((await coordinator.check(true)).phase, "failed");
  assert.equal((await f.store.load()).transaction, undefined);
  assert.equal((await f.store.load()).last_known_good_runtime.for_app_version, currentVersion);
  native.stageAutomatic = async () => {};
  assert.equal((await coordinator.check(true)).phase, "ready");
  const prepared = (await f.store.load()).transaction;
  assert.equal(prepared.previous_version, currentVersion);
  assert.equal(prepared.previous_runtime_version, previousVersion);
  assert.equal(prepared.previous_runtime, f.previous);
  assert.equal(await readFile(f.previous, "utf8"), "preserved previous runtime");
  native.installAutomatic = () => { throw new Error("Installer interrupted"); };
  await assert.rejects(coordinator.install(), /Installer interrupted/);
  assert.equal(coordinator.daemonStartupBlock(), null);
  await f.gate(coordinator).ready();
  assert.equal(f.process.version, previousVersion);
  assert.equal((await f.store.load()).transaction, undefined);
  // The next installed app can still roll back to 98, not mislabeled app 99.
  await f.store.update(s => { s.transaction = prepared; });
  await f.gate(new UpdateCoordinator(new UpdateStateStore(f.path), f.backend(nextVersion))).ready();
  assert.equal((await new UpdateStateStore(f.path).load()).last_known_good_runtime.for_app_version, nextVersion);
});

test("a healthy subsequent upgrade clears the app-bound fallback selection", async t => {
  const f = await fixture(t);
  const native = f.backend();
  const coordinator = new UpdateCoordinator(f.store, native);
  await f.gate(coordinator).ready();
  native.findLatest = async () => nextRelease;
  native.stageAutomatic = async () => {};
  assert.equal((await coordinator.check(true)).phase, "ready");
  await f.store.update(s => { s.transaction.phase = "installing"; });
  f.process.failTarget = false;
  const next = new UpdateCoordinator(new UpdateStateStore(f.path), f.backend(nextVersion));
  await f.gate(next).ready();
  const persisted = await new UpdateStateStore(f.path).load();
  assert.equal(persisted.transaction, undefined);
  assert.equal(persisted.last_known_good_runtime.for_app_version, undefined);
  assert.equal(persisted.last_known_good_runtime.version, previousVersion);
  assert.equal(persisted.highest_trusted_version, nextVersion);
  assert.deepEqual(next.daemonStartupRuntime(), { version: nextVersion, binary: null });
});

test("a verified rollback is not admitted if its durable selection cannot be written", async t => {
  const f = await fixture(t);
  const native = f.backend();
  const recover = native.recover.bind(native);
  native.recover = async transaction => {
    const result = await recover(transaction);
    await rename(f.path, `${f.path}.saved`);
    await mkdir(f.path);
    return result;
  };
  const coordinator = new UpdateCoordinator(f.store, native);
  await assert.rejects(f.gate(coordinator).request(async () => assert.fail("Unexpected IPC")));
  assert.equal((await f.store.load()).transaction.id, f.transaction.id);
  assert.equal((await f.store.load()).transaction.phase, "recovering");
  assert.equal((await f.store.load()).last_known_good_runtime, undefined);
  assert.equal(coordinator.daemonStartupRuntime().binary, null);
});

test("failed recovery-state persistence does not publish settlement in the store cache", async t => {
  const f = await fixture(t);
  await rename(f.path, `${f.path}.saved`);
  await mkdir(f.path);
  await assert.rejects(f.store.update(s => { delete s.transaction; }));
  assert.deepEqual((await f.store.load()).transaction, f.transaction);
});

test("version bindings round-trip and legacy transactions keep their original version meaning", async t => {
  const f = await fixture(t);
  const state = await f.store.load();
  assert.equal(parsePersistedState(state).transaction.previous_runtime_version, undefined);
  for (const field of ["previous_runtime_version", "for_app_version"]) {
    const invalid = structuredClone(state);
    if (field === "previous_runtime_version") invalid.transaction[field] = "not-a-version";
    else invalid.last_known_good_runtime = { version: previousVersion, path: f.previous, [field]: "not-a-version" };
    assert.throws(() => parsePersistedState(invalid));
  }
});
