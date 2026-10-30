#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, posix, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MARKER_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 250;
// `daemon stop` waits for the daemon's 10 s shutdown grace plus 5 s. Cleanup
// keeps its own bound so an exhausted probe deadline still stops the daemon.
const SHUTDOWN_TIMEOUT_MS = 30_000;
// Only the daemon's stable error codes and start/stop reasons may cross the
// canary boundary. Never reflect messages, account problems, identifiers,
// paths, or arbitrary code tokens.
const CLI_ERROR_CODES = new Set([
  "daemon_not_running", "daemon_unreachable", "start_failed", "not_ready",
  "invalid_request", "not_found", "unauthenticated", "forbidden", "unavailable",
  "rate_limited", "upgrade_required", "cancelled", "internal"
]);
// Stable `account.last_error` codes worth distinguishing while waiting for the
// account link; anything else is `account_error`.
const ACCOUNT_ERRORS = new Set([
  "device_registration_failed", "sign_in_expired", "authentication_required",
  "system_clock_wrong"
]);
// Variables that would select another profile, environment, or secret store.
const OVERRIDES = ["MDBASE_HOME", "MDBASE_ENV", "MDBASE_SECRET_BACKEND"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

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

class CanaryError extends Error {
  constructor(stage, code, exitCode = 1) {
    super(code);
    this.stage = stage;
    this.code = code;
    this.exitCode = exitCode;
  }
}

function configError(code = "invalid_config") {
  return new CanaryError("config", code, 2);
}

function parseArguments(argv, environmentVariables) {
  const supplied = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw configError();
    }
    const name = flag.slice(2);
    if (!Object.hasOwn(INPUTS, name) || supplied.has(name)) throw configError();
    supplied.set(name, value);
  }

  const value = (name) => {
    const argument = supplied.get(name);
    const environmentValue = environmentVariables[INPUTS[name]];
    if (argument !== undefined && environmentValue !== undefined) throw configError();
    const result = argument ?? environmentValue;
    if (result === undefined || result === "") throw configError();
    return result;
  };

  const environment = value("environment");
  const cli = value("cli");
  const stateDir = value("state-dir");
  const expectedOrigin = value("expected-origin");
  const collectionId = value("collection");
  const expectedCollectionName = value("expected-collection-name");
  const markerPath = value("marker-path");
  const expectedMarkerSha256 = value("expected-marker-sha256");
  const timeoutText = value("timeout-ms");
  const timeoutMs = Number(timeoutText);

  let parsedOrigin;
  try {
    parsedOrigin = new URL(expectedOrigin);
  } catch {
    throw configError();
  }
  if (!ENVIRONMENT.test(environment)
      || !isAbsolute(cli)
      || !isAbsolute(stateDir)
      || !["https:", "http:"].includes(parsedOrigin.protocol)
      || parsedOrigin.origin !== expectedOrigin
      || !UUID.test(collectionId)
      || expectedCollectionName.length > 200
      || markerPath.length > 1024
      || posix.isAbsolute(markerPath)
      || markerPath.includes("\\")
      || markerPath.split("/").some((part) => part === "" || part === "." || part === "..")
      || !DIGEST.test(expectedMarkerSha256)
      || !/^[1-9][0-9]*$/u.test(timeoutText)
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs > 300_000) {
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
    timeoutMs
  };
}

function elapsed(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function cliFailureCode(error) {
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_limit";
  if (error?.killed || error?.code === "ETIMEDOUT") return "timeout";
  if (error?.code === "ENOENT" || error?.code === "EACCES") return "cli_unavailable";
  if (error?.signal) return "cli_signaled";
  try {
    // `--json` prints `{"error": {code, reason?, message}}` on stdout.
    const failure = JSON.parse(error?.stdout)?.error;
    if (CLI_ERROR_CODES.has(failure?.reason)) return failure.reason;
    if (CLI_ERROR_CODES.has(failure?.code)) return failure.code;
  } catch {
    // Non-JSON output is deliberately discarded, not searched for messages.
  }
  return "cli_failed";
}

/** The marker's exact bytes, as a `sha256:` digest. */
export function markerSha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function accountState(status, options) {
  const account = status?.account;
  if (status?.secret_backend !== "keychain") return { terminal: "insecure_secret_backend" };
  if (account?.signed_in !== true || account.pairing) return { terminal: "not_signed_in" };
  if (account.server !== options.expectedOrigin) return { terminal: "origin_mismatch" };
  if (account.last_error) {
    return { waiting: ACCOUNT_ERRORS.has(account.last_error) ? account.last_error : "account_error" };
  }
  // The relay is a device-bound, authenticated control-plane session; this
  // daemon was started by this run, so `online` proves a fresh round trip.
  if (account.online !== true) return { waiting: "account_offline" };
  return { done: true };
}

function collectionOf(status, options, stage) {
  const matching = Array.isArray(status?.collections)
    ? status.collections.filter((item) => item?.id === options.collectionId)
    : [];
  if (matching.length !== 1) throw new CanaryError(stage, "missing_collection");
  const collection = matching[0];
  if (collection.name !== options.expectedCollectionName
      || collection.mode !== "synced"
      || collection.log !== "hosted") {
    throw new CanaryError(stage, "collection_mismatch");
  }
  return collection;
}

function syncState(collection) {
  if (collection.state === "failed" || collection.state === "paused") {
    return { terminal: `collection_${collection.state}` };
  }
  if (collection.state !== "ready") {
    return { waiting: collection.state === "unavailable" ? "collection_unavailable" : "collection_opening" };
  }
  const sync = collection.sync;
  if (!sync) return { waiting: "collection_opening" };
  if (sync.holds !== 0) return { terminal: "holds_present" };
  if (sync.unresolved !== 0) return { terminal: "conflicts_present" };
  // A freshly opened hosted replica starts `connecting`; it turns `online`
  // only on an authenticated read or subscribe reply from the hosted log.
  if (sync.connection !== "online") return { waiting: "log_offline" };
  if (sync.resyncing
      || !Number.isSafeInteger(sync.head_known)
      || sync.head_known < 1
      || sync.confirmed_through !== sync.head_known) {
    return { waiting: "not_caught_up" };
  }
  if (sync.pending !== 0) return { waiting: "local_changes_pending" };
  return { done: true };
}

async function readMarker(collection, markerPath) {
  if (typeof collection.root !== "string" || !isAbsolute(collection.root)) {
    throw new CanaryError("read", "invalid_response");
  }
  let root;
  let target;
  try {
    root = await realpath(collection.root);
    target = resolve(root, ...markerPath.split("/"));
    const entry = await lstat(target);
    if (!entry.isFile()) throw new CanaryError("read", "marker_mismatch");
    if (!(await realpath(target)).startsWith(`${root}${sep}`)) {
      throw new CanaryError("read", "marker_mismatch");
    }
    if (entry.size > MAX_MARKER_BYTES) throw new CanaryError("read", "marker_too_large");
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    throw new CanaryError("read", error?.code === "ENOENT" ? "marker_missing" : "marker_unreadable");
  }
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const bytes = await handle.readFile();
    if (bytes.length > MAX_MARKER_BYTES) throw new CanaryError("read", "marker_too_large");
    return bytes;
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    throw new CanaryError("read", "marker_unreadable");
  } finally {
    await handle?.close();
  }
}

export async function runCanary(
  argv = process.argv.slice(2),
  environmentVariables = process.env
) {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  const stages = [];
  const environmentArgument = argv.indexOf("--environment");
  const suppliedEnvironment = environmentArgument === -1
    ? environmentVariables[INPUTS.environment]
    : argv[environmentArgument + 1];
  let environment = ENVIRONMENT.test(suppliedEnvironment ?? "") ? suppliedEnvironment : "unknown";
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
  const runCli = async (stage, argumentsList, timeout) => {
    try {
      const { stdout } = await execFileAsync(
        options.cli,
        ["--state-dir", options.stateDir, "--json", ...argumentsList],
        { env: environmentVariables, timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }
      );
      return JSON.parse(stdout);
    } catch (error) {
      if (error instanceof SyntaxError) throw new CanaryError(stage, "malformed_json");
      throw new CanaryError(stage, cliFailureCode(error));
    }
  };

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

    await runStage("registration", async () => {
      // Every run starts its own daemon, so each online state below is new.
      daemonOwned = true;
      const start = await runCli("registration", ["daemon", "start"], remainingTime("registration"));
      if (start?.started !== true) {
        daemonOwned = start?.started !== false;
        throw new CanaryError("registration", start?.started === false
          ? "daemon_already_running"
          : "invalid_response");
      }
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

    const bytes = await runStage("read", () => readMarker(synced, options.markerPath));

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
