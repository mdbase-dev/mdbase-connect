import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
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

test("a CONNECT blackhole during real Sigstore verification fails closed and permits recovery", { timeout: 20_000 }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-blackhole-"));
  const sockets = new Set();
  let worker;
  const proxy = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (bytes) => {
      assert.match(bytes.toString(), /^CONNECT /);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      proxy.emit("tunnel");
    });
  });
  context.after(async () => {
    await worker?.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  worker = new Worker(new URL("fixtures/update-check-blackhole.mjs", import.meta.url), {
    workerData: { directory },
    env: { ...process.env, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" }
  });
  await Promise.race([
    once(proxy, "tunnel"),
    once(worker, "error").then(([error]) => { throw error; })
  ]);
  const expired = once(worker, "message");
  worker.postMessage("expire");
  const [result] = await expired;
  assert.equal(result.status.phase, "failed");
  assert.match(result.status.message, /^Could not verify updates: .*timed out/i);
  assert.equal(result.status.can_install, false);
  assert.equal(result.trustedVersion, undefined);
  assert.equal(result.settled, true);
  const recovered = once(worker, "message");
  worker.postMessage("recover");
  assert.equal((await recovered)[0].phase, "external");
});

for (const manual of [false, true]) {
  test(`${manual ? "manual" : "automatic"} checks release their guard even when discovery ignores cancellation`, async (context) => {
    const { store } = await fixture();
    let finishDiscovery;
    let checkSignal;
    const runtime = backend({
      findLatest(signal) {
        checkSignal = signal;
        return new Promise((resolve) => { finishDiscovery = resolve; });
      }
    });
    const coordinator = new UpdateCoordinator(store, runtime);
    await coordinator.initialize();
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = coordinator.check(manual);
    await setImmediate();
    context.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(coordinator.status().phase, "failed");
    assert.equal((await pending).can_check, true);
    assert.equal(checkSignal.aborted, true);
    runtime.findLatest = async () => null;
    assert.equal((await coordinator.check(true)).phase, "idle");
    finishDiscovery({ manifest: signedManifest() });
    await setImmediate();
    assert.equal(coordinator.status().phase, "idle");
    assert.deepEqual(runtime.events, []);
    assert.equal((await store.load()).highest_trusted_version, undefined);
  });
}

test("staging gets its own longer deadline and ignores expired progress and completion", async (context) => {
  const { store } = await fixture();
  let finishStaging;
  let reportProgress;
  const started = Promise.withResolvers();
  const runtime = backend({
    findLatest() {
      return new Promise((resolve) => setTimeout(() => resolve({ manifest: signedManifest() }), 45_000));
    },
    stageAutomatic(_manifest, _target, progress) {
      reportProgress = progress;
      started.resolve();
      return new Promise((resolve) => { finishStaging = resolve; });
    }
  });
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = coordinator.check();
  await setImmediate();
  context.mock.timers.tick(45_000);
  await started.promise;
  // Past the 60-second check deadline: a slow download is not a stalled check.
  context.mock.timers.tick(15 * 60_000 - 1);
  await setImmediate();
  assert.equal(coordinator.status().phase, "downloading");
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(coordinator.status().phase, "failed");
  await pending;
  runtime.findLatest = async () => null;
  assert.equal((await coordinator.check(true)).phase, "idle");
  reportProgress(100);
  finishStaging();
  await setImmediate();
  assert.equal(coordinator.status().phase, "idle");
  await assert.rejects(coordinator.install(), /No update is ready/);
});

for (const operation of ["load", "update"]) {
  test(`the overall deadline also covers a stalled state ${operation}`, async (context) => {
    const { store } = await fixture();
    const coordinator = new UpdateCoordinator(store, backend());
    await coordinator.initialize();
    const original = store[operation].bind(store);
    store[operation] = () => new Promise(() => {});
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = coordinator.check();
    await setImmediate();
    context.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(coordinator.status().phase, "failed");
    assert.equal((await pending).can_install, false);
    store[operation] = original;
    assert.equal((await coordinator.check(true)).phase, "ready");
  });
}

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

test("a repeated manual check while an external update is available stays external", async () => {
  const { store } = await fixture();
  const external = {
    mode: "manual",
    action_url: "https://example.com/mdbase-connect.deb",
    artifacts: [
      {
        name: "mdbase-connect.deb",
        url: "https://example.com/mdbase-connect.deb",
        sigstore_url: "https://example.com/mdbase-connect.deb.sigstore.json",
        sha256: "c".repeat(64),
        size: 100,
        kind: "deb"
      }
    ]
  };
  let downloads = 0;
  const runtime = backend({
    async findLatest() {
      return { manifest: signedManifest(external) };
    },
    async openExternal() {
      downloads += 1;
    }
  });
  const coordinator = new UpdateCoordinator(store, runtime);
  await coordinator.initialize();
  const first = await coordinator.check(true);
  assert.equal(first.phase, "external");
  const second = await coordinator.check(true);
  assert.equal(second.phase, "external");
  assert.equal(second.target_version, first.target_version);
  assert.equal(second.message, first.message);
  assert.equal(second.can_check, true);
  assert.equal(second.can_install, true);
  assert.equal(downloads, 0);
  const installed = await coordinator.install();
  assert.equal(installed.phase, "external");
  assert.equal(downloads, 1);
});

test("two manual checks while external share the in-flight check", async () => {
  const { store } = await fixture();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const external = {
    mode: "store",
    action_url: "https://apps.microsoft.com/detail/example",
    artifacts: []
  };
  const coordinator = new UpdateCoordinator(store, backend({
    async findLatest() {
      calls += 1;
      await gate;
      return { manifest: signedManifest(external) };
    }
  }));
  await coordinator.initialize();
  const first = coordinator.check(true);
  const second = coordinator.check(true);
  assert.equal(first, second);
  release();
  assert.equal((await first).phase, "external");
  assert.equal(calls, 1);
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
