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
    async findLatest() {
      events.push("find");
      return { manifest: signedManifest() };
    },
    async stageAutomatic(_manifest, _target, progress) {
      events.push("stage");
      progress(35);
      progress(90);
    },
    installAutomatic() {
      events.push("install");
    },
    async openExternal(url) {
      events.push(`open:${url}`);
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

test("a verified automatic release downloads, becomes ready and installs the app only", async () => {
  const { path, store } = await fixture();
  const runtime = backend();
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  const phases = [];
  coordinator.subscribe((status) => phases.push(status.phase));
  const status = await coordinator.check();
  assert.equal(status.phase, "ready");
  assert.equal(status.target_version, "0.1.0-beta.9");
  assert.equal(status.can_install, true);
  assert.deepEqual(phases.slice(0, 3), ["idle", "checking", "downloading"]);
  await coordinator.check();
  assert.deepEqual(runtime.events, ["find", "stage"]);
  assert.equal((await coordinator.install()).phase, "installing");
  assert.deepEqual(runtime.events, ["find", "stage", "install"]);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.highest_trusted_version, "0.1.0-beta.9");
  assert.equal(saved.transaction, undefined);
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
});

test("download and verification failures never enable installation", async () => {
  const { store } = await fixture();
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
  assert.equal(status.can_check, true);
  assert.match(status.message, /signature mismatch/);
  await assert.rejects(coordinator.install(), /No update is ready/);
});

test("a rolled-back daemon notice stays with every update status until cleared", async () => {
  const { store } = await fixture();
  const coordinator = new UpdateCoordinator(store, backend());
  await coordinator.initialize();
  coordinator.setDaemonNotice("mdbase 0.3.0 did not start.");
  assert.equal(coordinator.status().daemon_notice, "mdbase 0.3.0 did not start.");
  assert.equal((await coordinator.check()).daemon_notice, "mdbase 0.3.0 did not start.");
  coordinator.setDaemonNotice(null);
  assert.equal(coordinator.status().daemon_notice, undefined);
});
