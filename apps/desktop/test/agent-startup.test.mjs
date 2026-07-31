import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { ensureAgentReady } = require("../dist/main/agent-startup.js");

function unavailable() {
  return Object.assign(new Error("No local connector"), { code: "ENOENT" });
}

const options = (overrides = {}) => ({
  ping: async () => ({ pong: true, ready: true }),
  launch: async () => {},
  endpointIsUnavailable: (error) =>
    error && typeof error === "object" && ["ENOENT", "ECONNREFUSED"].includes(error.code),
  incompatibleDaemon: (error) =>
    error && typeof error === "object" && error.code === "unsupported_local_protocol",
  readinessTimeoutMs: 100,
  pollIntervalMs: 1,
  ...overrides
});

test("a slow daemon keeps initializing after its launch command times out", async () => {
  let pingCount = 0;
  const launchError = new Error("daemon start timed out");

  await ensureAgentReady(options({
    ping: async () => {
      pingCount += 1;
      if (pingCount === 1) throw unavailable();
      if (pingCount === 2) throw new Error("The local connector did not respond in time.");
      return { pong: true, ready: pingCount >= 4 };
    },
    launch: async () => {
      throw launchError;
    }
  }));

  assert.equal(pingCount, 4);
});

test("a launch failure is preserved when no daemon opened the endpoint", async () => {
  const launchError = new Error("system service could not start");

  await assert.rejects(
    ensureAgentReady(options({
      ping: async () => {
        throw unavailable();
      },
      launch: async () => {
        throw launchError;
      }
    })),
    (error) => error === launchError
  );
});

test("an incompatible daemon fails immediately", async () => {
  const incompatible = Object.assign(new Error("Unsupported protocol"), {
    code: "unsupported_local_protocol"
  });
  let launched = false;

  await assert.rejects(
    ensureAgentReady(options({
      ping: async () => {
        throw incompatible;
      },
      launch: async () => {
        launched = true;
      }
    })),
    (error) => error === incompatible
  );
  assert.equal(launched, false);
});
