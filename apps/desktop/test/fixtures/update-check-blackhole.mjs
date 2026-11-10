import { createRequire } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url);
const { UpdateCoordinator } = require("../../dist/main/update-coordinator.js");
const { UpdateStateStore } = require("../../dist/main/update-state.js");
const { findLatestRelease } = require("../../dist/main/release-source.js");
const tag = "v0.1.0-beta.9";
const releaseUrl = `https://github.com/mdbase-dev/mdbase-connect/releases/tag/${tag}`;
const manifest = {
  schema_version: 1,
  version: "0.1.0-beta.9",
  tag,
  channel: "beta",
  published_at: "2026-07-28T00:00:00.000Z",
  release_url: releaseUrl,
  notes: "Test release",
  rollout: { percentage: 100, seed: tag },
  blocked_versions: [],
  targets: { "linux-x64": { mode: "manual", action_url: releaseUrl, artifacts: [] } }
};
const store = new UpdateStateStore(join(workerData.directory, "state.json"));
const backend = {
  currentVersion: "0.1.0-beta.8",
  channel: "beta",
  platformKey: "linux-x64",
  packaged: true,
  findLatest(signal) {
    return findLatestRelease({
      channel: "beta",
      trustCacheDirectory: join(workerData.directory, "sigstore"),
      signal,
      async fetchImpl(url) {
        const body = url.includes("api.github.com") ? [{
          draft: false, prerelease: true, tag_name: tag, html_url: releaseUrl,
          assets: [
            { name: "mdbase-connect-channel-v1.json", browser_download_url: "https://example.com/manifest", size: 1000 },
            { name: "mdbase-connect-channel-v1.json.sigstore.json", browser_download_url: "https://example.com/bundle", size: 1000 }
          ]
        }] : url.endsWith("/manifest") ? manifest : {};
        const response = new Response(JSON.stringify(body));
        Object.defineProperty(response, "url", { value: url });
        return response;
      }
    });
  },
  installsAutomatically: (target) => target.mode === "automatic",
  async stageAutomatic() { throw new Error("Unverified releases must not be staged."); },
  async installAutomatic() { throw new Error("Unverified releases must not be installed."); },
  async openExternal() {}
};
const coordinator = new UpdateCoordinator(store, backend);
await coordinator.initialize();
mock.timers.enable({ apis: ["setTimeout"] });
let settled = false;
void coordinator.check(true).then(() => { settled = true; });
parentPort.on("message", async (command) => {
  if (command === "expire") {
    mock.timers.tick(60_000);
    await setImmediate();
    parentPort.postMessage({ status: coordinator.status(), settled, trustedVersion: (await store.load()).highest_trusted_version });
  } else if (command === "recover") {
    backend.findLatest = async () => ({ manifest });
    parentPort.postMessage(await coordinator.check(true));
  }
});
