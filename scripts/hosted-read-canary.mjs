#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CanaryError,
  OVERRIDES,
  UUID,
  ENVIRONMENT,
  accountState,
  collectionOf,
  configError,
  elapsed,
  inputReader,
  isCollectionPath,
  isOrigin,
  isTimeout,
  readCollectionFile,
  reportedEnvironment,
  runCli as runCliIn,
  syncState
} from "./lib/hosted-canary.mjs";

const POLL_INTERVAL_MS = 250;
// `daemon stop` waits for the daemon's 10 s shutdown grace plus 5 s. Cleanup
// keeps its own bound so an exhausted probe deadline still stops the daemon.
const SHUTDOWN_TIMEOUT_MS = 30_000;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

const INPUTS = {
  environment: "MDBASE_HOSTED_CANARY_ENVIRONMENT",
  cli: "MDBASE_HOSTED_CANARY_CLI",
  "state-dir": "MDBASE_HOSTED_CANARY_STATE_DIR",
  "expected-origin": "MDBASE_HOSTED_CANARY_EXPECTED_ORIGIN",
  collection: "MDBASE_HOSTED_CANARY_COLLECTION",
  "expected-collection-name": "MDBASE_HOSTED_CANARY_EXPECTED_COLLECTION_NAME",
  "marker-path": "MDBASE_HOSTED_CANARY_MARKER_PATH",
  "expected-marker-sha256": "MDBASE_HOSTED_CANARY_EXPECTED_MARKER_SHA256",
  "timeout-ms": "MDBASE_HOSTED_CANARY_TIMEOUT_MS"
};

function parseArguments(argv, environmentVariables) {
  const { value } = inputReader(argv, environmentVariables, INPUTS);
  const environment = value("environment");
  const cli = value("cli");
  const stateDir = value("state-dir");
  const expectedOrigin = value("expected-origin");
  const collectionId = value("collection");
  const expectedCollectionName = value("expected-collection-name");
  const markerPath = value("marker-path");
  const expectedMarkerSha256 = value("expected-marker-sha256");
  const timeoutText = value("timeout-ms");

  if (!ENVIRONMENT.test(environment)
      || !isAbsolute(cli)
      || !isAbsolute(stateDir)
      || !isOrigin(expectedOrigin)
      || !UUID.test(collectionId)
      || expectedCollectionName.length > 200
      || !isCollectionPath(markerPath)
      || !DIGEST.test(expectedMarkerSha256)
      || !isTimeout(timeoutText)) {
    throw configError();
  }

  return {
    environment,
    cli,
    stateDir,
    expectedOrigin,
    collectionId,
    expectedCollectionName,
    markerPath,
    expectedMarkerSha256,
    timeoutMs: Number(timeoutText)
  };
}

/** The marker's exact bytes, as a `sha256:` digest. */
export function markerSha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function runCanary(
  argv = process.argv.slice(2),
  environmentVariables = process.env
) {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  const stages = [];
  let environment = reportedEnvironment(argv, environmentVariables, INPUTS.environment);
  let currentStage = "config";
  let failure;

  const runStage = async (name, action) => {
    currentStage = name;
    const stageStarted = performance.now();
    try {
      const result = await action();
      stages.push({ name, status: "operational", duration_ms: elapsed(stageStarted) });
      return result;
    } catch (error) {
      stages.push({ name, status: "failed", duration_ms: elapsed(stageStarted) });
      throw error;
    }
  };

  let options;
  let daemonOwned = false;
  const runCli = (stage, argumentsList, timeout) => runCliIn(
    { cli: options.cli, stateDir: options.stateDir, environmentVariables },
    stage,
    argumentsList,
    timeout
  );

  try {
    options = await runStage("config", async () => {
      const parsed = parseArguments(argv, environmentVariables);
      environment = parsed.environment;
      if (OVERRIDES.some((name) => environmentVariables[name] !== undefined)) {
        throw configError("environment_override");
      }
      await access(parsed.cli, constants.X_OK).catch(() => { throw configError("cli_unavailable"); });
      const state = await stat(parsed.stateDir).catch(() => { throw configError("state_unavailable"); });
      if (!state.isDirectory()) throw configError("state_unavailable");
      return parsed;
    });

    const deadline = performance.now() + options.timeoutMs;
    const remainingTime = (stage) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new CanaryError(stage, "timeout");
      return remaining;
    };
    const status = (stage) => runCli(stage, ["status"], remainingTime(stage));
    // Poll the daemon until `evaluate` is done or terminal. At the deadline the
    // last waiting reason is the failure code.
    const awaitStatus = async (stage, evaluate) => {
      let waiting;
      for (;;) {
        let current;
        try {
          current = await status(stage);
        } catch (error) {
          // The deadline can also run out during a poll.
          if (waiting && error instanceof CanaryError && error.code === "timeout") {
            throw new CanaryError(stage, waiting);
          }
          throw error;
        }
        const state = evaluate(current);
        if (state.done) return current;
        if (state.terminal) throw new CanaryError(stage, state.terminal);
        waiting = state.waiting;
        if (deadline - performance.now() <= POLL_INTERVAL_MS) {
          throw new CanaryError(stage, state.waiting);
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_INTERVAL_MS));
      }
    };

    await runStage("daemon_start", async () => {
      // Every run starts its own daemon, so each online state below is new.
      daemonOwned = true;
      const start = await runCli("daemon_start", ["daemon", "start"], remainingTime("daemon_start"));
      if (start?.started !== true) {
        daemonOwned = start?.started !== false;
        throw new CanaryError("daemon_start", start?.started === false
          ? "daemon_already_running"
          : "invalid_response");
      }
    });

    await runStage("registration", async () => {
      await awaitStatus("registration", (current) => accountState(current, options));
    });

    await runStage("connections", async () => {
      collectionOf(await status("connections"), options, "connections");
    });

    const synced = await runStage("describe", async () => collectionOf(
      await awaitStatus("describe", (current) => syncState(collectionOf(current, options, "describe"))),
      options,
      "describe"
    ));

    const bytes = await runStage("read", () => readCollectionFile(synced, options.markerPath, "read"));

    await runStage("digest", async () => {
      if (markerSha256(bytes) !== options.expectedMarkerSha256) {
        throw new CanaryError("digest", "digest_mismatch");
      }
    });
  } catch (error) {
    failure = error instanceof CanaryError
      ? error
      : new CanaryError(currentStage, "internal_error");
    if (!stages.some((stage) => stage.name === failure.stage && stage.status === "failed")) {
      stages.push({ name: failure.stage, status: "failed", duration_ms: 0 });
    }
  }

  if (daemonOwned) {
    try {
      await runStage("shutdown", async () => {
        const stopped = await runCli("shutdown", ["daemon", "stop"], SHUTDOWN_TIMEOUT_MS);
        if (typeof stopped?.stopped !== "boolean") throw new CanaryError("shutdown", "invalid_response");
      });
    } catch (error) {
      failure ??= error instanceof CanaryError ? error : new CanaryError("shutdown", "internal_error");
    }
  }

  return {
    exitCode: failure?.exitCode ?? 0,
    result: {
      schema_version: 1,
      environment,
      component: "hosted_canary",
      status: failure ? "failed" : "operational",
      checked_at: checkedAt,
      duration_ms: elapsed(started),
      stages,
      ...(failure ? { error: { stage: failure.stage, code: failure.code } } : {})
    }
  };
}

async function main() {
  const { exitCode, result } = await runCanary();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
