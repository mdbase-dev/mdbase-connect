import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { UpdateCoordinator } = require("../dist/main/update-coordinator.js");
const { parseUpdateManifest } = require("../dist/main/update-policy.js");
const { UpdateStateStore } = require("../dist/main/update-state.js");

function signedManifest(target = automaticTarget()) {
  return parseUpdateManifest({
    schema_version: 1,
    version: "0.1.0-beta.9",
    tag: "v0.1.0-beta.9",
    channel: "beta",
    published_at: "2026-07-28T00:00:00.000Z",
    release_url: "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.9",
    notes: "Update notes.",
    rollout: { percentage: 100, seed: "v0.1.0-beta.9" },
    blocked_versions: [],
    targets: { "darwin-arm64": target }
  });
}

function automaticTarget() {
  return {
    mode: "automatic",
    action_url: "https://example.com/release",
    artifacts: [
      {
        name: "update.zip",
        url: "https://example.com/update.zip",
        sigstore_url: "https://example.com/update.zip.sigstore.json",
        sha256: "b".repeat(64),
        size: 100,
        kind: "zip"
      }
    ]
  };
}

function backend(overrides = {}) {
  const events = [];
  return {
    events,
    currentVersion: "0.1.0-beta.8",
    channel: "beta",
    platformKey: "darwin-arm64",
    packaged: true,
    async reconcileInstalledRuntime() {
      events.push("reconcile");
      return null;
    },
    async findLatest() {
      events.push("find");
      return { manifest: signedManifest() };
    },
    async stageAutomatic(_manifest, _target, progress) {
      events.push("stage");
      progress(35);
      progress(90);
    },
    async prepareDaemonHandoff() {
      events.push("prepare");
      return { serviceInstalled: true, previousRuntime: "/runtime/beta.8" };
    },
    async stopDaemon() {
      events.push("stop");
    },
    installAutomatic() {
      events.push("install");
    },
    async openExternal(url) {
      events.push(`open:${url}`);
    },
    async recover() {
      events.push("recover");
      return { healthy: true, rolledBack: false, message: "Recovered." };
    },
    ...overrides
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-coordinator-"));
  return {
    path: join(directory, "state.json"),
    store: new UpdateStateStore(join(directory, "state.json"))
  };
}

test("a verified automatic release moves through download to ready", async () => {
  const { store } = await fixture();
  const runtime = backend();
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  const phases = [];
  coordinator.subscribe((status) => phases.push(status.phase));
  const status = await coordinator.check();
  assert.equal(status.phase, "ready");
  assert.equal(status.target_version, "0.1.0-beta.9");
  assert.equal(status.progress, 100);
  assert.equal(status.can_install, true);
  assert.deepEqual(runtime.events, ["reconcile", "find", "prepare", "stage"]);
  assert.ok(phases.includes("checking"));
  assert.ok(phases.includes("downloading"));
  assert.equal(phases.at(-1), "ready");
  await coordinator.check();
  assert.deepEqual(runtime.events, ["reconcile", "find", "prepare", "stage"]);
});

test("startup surfaces runtime reconciliation and fails closed when it cannot complete", async () => {
  const first = await fixture();
  const reconciled = new UpdateCoordinator(
    first.store,
    backend({
      async reconcileInstalledRuntime() {
        return "Stable runtime refreshed.";
      }
    })
  );
  assert.match((await reconciled.initialize()).message, /refreshed/);

  const second = await fixture();
  const failed = new UpdateCoordinator(
    second.store,
    backend({
      async reconcileInstalledRuntime() {
        throw new Error("service registration denied");
      }
    })
  );
  const status = await failed.initialize();
  assert.equal(status.phase, "failed");
  assert.equal(status.can_check, false);
  assert.match(status.message, /service registration denied/);
  await failed.check();
  assert.deepEqual(failed.status(), status);
});

test("only one network check runs while a check is in flight", async () => {
  const { store } = await fixture();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runtime = backend({
    async findLatest() {
      calls += 1;
      await gate;
      return { manifest: signedManifest() };
    }
  });
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  const first = coordinator.check();
  const second = coordinator.check();
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 1);
});

test("daemon handoff is persisted before stop and survives process exit", async () => {
  const { path, store } = await fixture();
  const runtime = backend();
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  await coordinator.check();
  await coordinator.install();
  assert.deepEqual(runtime.events, ["reconcile", "find", "prepare", "stage", "stop", "install"]);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.transaction.phase, "installing");
  assert.equal(persisted.transaction.previous_runtime, "/runtime/beta.8");
  assert.equal(persisted.transaction.target_version, "0.1.0-beta.9");
});

test("the next application version rebinds and health-checks the daemon transaction", async () => {
  const { path, store } = await fixture();
  const oldRuntime = backend();
  const oldCoordinator = new UpdateCoordinator(store, oldRuntime);
  await oldCoordinator.initialize();
  await oldCoordinator.check();
  await oldCoordinator.install();

  let recoveredTransaction;
  const newRuntime = backend({
    currentVersion: "0.1.0-beta.9",
    async recover(transaction) {
      recoveredTransaction = transaction;
      return { healthy: true, rolledBack: false, message: "Upgrade healthy." };
    }
  });
  const newCoordinator = new UpdateCoordinator(new UpdateStateStore(path), newRuntime);
  const status = await newCoordinator.initialize();
  assert.equal(status.phase, "idle");
  assert.equal(recoveredTransaction.previous_version, "0.1.0-beta.8");
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.transaction, undefined);
  assert.equal(persisted.highest_trusted_version, "0.1.0-beta.9");
  assert.equal(persisted.last_known_good_runtime.path, "/runtime/beta.8");
});

test("rolled-back recovery remains visible and allows another check", async () => {
  const { path, store } = await fixture();
  const initial = backend();
  const coordinator = new UpdateCoordinator(store, initial);
  await coordinator.initialize();
  await coordinator.check();
  await coordinator.install();

  const recovering = new UpdateCoordinator(
    new UpdateStateStore(path),
    backend({
      currentVersion: "0.1.0-beta.9",
      async recover() {
        return {
          healthy: true,
          rolledBack: true,
          message: "The prior connector was restored."
        };
      }
    })
  );
  const status = await recovering.initialize();
  assert.equal(status.phase, "recovery");
  assert.equal(status.can_check, true);
  assert.match(status.message, /restored/);
  assert.equal((await recovering.check()).phase, "idle");
});

test("Store and package-manager updates open the signed action target", async () => {
  const { store } = await fixture();
  const external = {
    mode: "store",
    action_url: "https://apps.microsoft.com/detail/example",
    artifacts: []
  };
  const runtime = backend({
    async findLatest() {
      return { manifest: signedManifest(external) };
    }
  });
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  const status = await coordinator.check(true);
  assert.equal(status.phase, "external");
  await coordinator.install();
  assert.ok(runtime.events.includes("open:https://apps.microsoft.com/detail/example"));
  assert.ok(!runtime.events.includes("stop"));
});

test("download and verification failures never enable installation", async () => {
  const { path, store } = await fixture();
  const runtime = backend({
    async stageAutomatic() {
      throw new Error("signature mismatch");
    }
  });
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  const status = await coordinator.check();
  assert.equal(status.phase, "failed");
  assert.equal(status.can_install, false);
  assert.match(status.message, /signature mismatch/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).transaction, undefined);
});

test("a stop failure invokes recovery and clears the transaction", async () => {
  const { path, store } = await fixture();
  const runtime = backend({
    async stopDaemon() {
      runtime.events.push("stop");
      throw new Error("daemon refused shutdown");
    }
  });
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  await coordinator.check();
  await assert.rejects(coordinator.install(), /daemon refused shutdown/);
  assert.ok(runtime.events.includes("recover"));
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.transaction, undefined);
  assert.equal(coordinator.status().phase, "failed");
  assert.equal(coordinator.status().can_install, false);
  await assert.rejects(coordinator.install(), /No update is ready/);
});
