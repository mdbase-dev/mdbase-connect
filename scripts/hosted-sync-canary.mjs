#!/usr/bin/env node

// Measures how long one edit takes to travel from a writer computer, through
// the hosted log, into a reader computer's folder. See docs/headless.md.

import { randomBytes } from "node:crypto";
import { access, lstat, open, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CanaryError,
  ENVIRONMENT,
  OVERRIDES,
  UUID,
  accountState,
  collectionOf,
  configError,
  confinedPath,
  elapsed,
  inputReader,
  isCollectionPath,
  isOrigin,
  isTimeout,
  readCollectionFile,
  reportedEnvironment,
  runCli,
  syncState
} from "./lib/hosted-canary.mjs";

// One status call takes a few milliseconds; at this interval a run of under a
// second costs a few dozen short CLI processes.
const POLL_INTERVAL_MS = 25;
const PUBLISH_TIMEOUT_MS = 10_000;
const MAX_TOKEN_BYTES = 4096;
const STAGES = ["detect", "upload", "notify", "apply"];

const INPUTS = {
  environment: "MDBASE_SYNC_CANARY_ENVIRONMENT",
  cli: "MDBASE_SYNC_CANARY_CLI",
  "writer-state-dir": "MDBASE_SYNC_CANARY_WRITER_STATE_DIR",
  "reader-state-dir": "MDBASE_SYNC_CANARY_READER_STATE_DIR",
  "expected-origin": "MDBASE_SYNC_CANARY_EXPECTED_ORIGIN",
  collection: "MDBASE_SYNC_CANARY_COLLECTION",
  "expected-collection-name": "MDBASE_SYNC_CANARY_EXPECTED_COLLECTION_NAME",
  "probe-path": "MDBASE_SYNC_CANARY_PROBE_PATH",
  "timeout-ms": "MDBASE_SYNC_CANARY_TIMEOUT_MS",
  "timings-url": "MDBASE_SYNC_CANARY_TIMINGS_URL",
  "timings-token-file": "MDBASE_SYNC_CANARY_TIMINGS_TOKEN_FILE"
};

function parseArguments(argv, environmentVariables) {
  const { value, optional } = inputReader(argv, environmentVariables, INPUTS);
  const options = {
    environment: value("environment"),
    cli: value("cli"),
    writerStateDir: value("writer-state-dir"),
    readerStateDir: value("reader-state-dir"),
    expectedOrigin: value("expected-origin"),
    collectionId: value("collection"),
    expectedCollectionName: value("expected-collection-name"),
    probePath: value("probe-path"),
    timeoutMs: value("timeout-ms"),
    timingsUrl: optional("timings-url"),
    timingsTokenFile: optional("timings-token-file")
  };
  if (!ENVIRONMENT.test(options.environment)
      || !isAbsolute(options.cli)
      || !isAbsolute(options.writerStateDir)
      || !isAbsolute(options.readerStateDir)
      || resolve(options.writerStateDir) === resolve(options.readerStateDir)
      || !isOrigin(options.expectedOrigin)
      || !UUID.test(options.collectionId)
      || options.expectedCollectionName.length > 200
      || !isCollectionPath(options.probePath)
      || !isTimeout(options.timeoutMs)
      || (options.timingsUrl === undefined) !== (options.timingsTokenFile === undefined)
      || (options.timingsUrl !== undefined
          && (!/^https:\/\/[^/?#]+\/[^?#]*$/u.test(options.timingsUrl)
              || !isAbsolute(options.timingsTokenFile)))) {
    throw configError();
  }
  return { ...options, timeoutMs: Number(options.timeoutMs) };
}

/** The probe file's content for one run. Only the nonce changes. */
export function probeDocument(nonce) {
  return `Sync canary probe.\n\nnonce: ${nonce}\n`;
}

/**
 * Turn first observations into stage durations on one clock. A later
 * milestone proves every earlier one (the reader cannot apply what it was not
 * told about), so each milestone is the earliest evidence for it. Returns the
 * stages that completed and, when one did not, the first missing one.
 */
export function stageTimings(observed) {
  const milestones = [];
  let missing;
  let bound = Infinity;
  for (let index = STAGES.length - 1; index >= 0; index -= 1) {
    bound = Math.min(bound, observed[STAGES[index]] ?? Infinity);
    milestones[index] = bound;
  }
  const stages = [];
  let previous = 0;
  for (const [index, name] of STAGES.entries()) {
    if (milestones[index] === Infinity) {
      missing = name;
      break;
    }
    stages.push({ name, status: "operational", duration_ms: Math.max(0, Math.round(milestones[index] - previous)) });
    previous = milestones[index];
  }
  return { stages, missing, reachedAt: previous };
}

async function writeProbe(collection, probePath, document) {
  const target = await confinedPath(collection, probePath, "write", { requireFile: false });
  let handle;
  try {
    // In place, as an editor saves: truncate and write the whole file.
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(document);
  } catch {
    throw new CanaryError("write", "probe_unwritable");
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
  let environment = reportedEnvironment(argv, environmentVariables, INPUTS.environment);
  let stages = [];
  let wrote;
  let options;
  let failure;

  try {
    options = parseArguments(argv, environmentVariables);
    environment = options.environment;
    if (OVERRIDES.some((name) => environmentVariables[name] !== undefined)) {
      throw configError("environment_override");
    }
    await access(options.cli, constants.X_OK).catch(() => { throw configError("cli_unavailable"); });
    for (const stateDir of [options.writerStateDir, options.readerStateDir]) {
      const state = await stat(stateDir).catch(() => { throw configError("state_unavailable"); });
      if (!state.isDirectory()) throw configError("state_unavailable");
    }

    const deadline = performance.now() + options.timeoutMs;
    const remaining = (stage) => {
      const left = Math.floor(deadline - performance.now());
      if (left <= 0) throw new CanaryError(stage, "timeout");
      return left;
    };
    const status = (stateDir, stage) => runCli(
      { cli: options.cli, stateDir, environmentVariables },
      stage,
      ["status"],
      remaining(stage)
    );
    const pause = () => new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_INTERVAL_MS));
    // A device that cannot take part: signed out, its collection gone, failed
    // or holding files. Waiting reasons are kept to explain a timeout.
    const device = (current, stage) => {
      const account = accountState(current, options);
      if (account.terminal) throw new CanaryError(stage, account.terminal);
      const collection = collectionOf(current, options, stage);
      const sync = syncState(collection);
      if (sync.terminal) throw new CanaryError(stage, sync.terminal);
      return { collection, account, sync };
    };

    // Preflight: both daemons (already running) are on the same account,
    // distinct devices, online and caught up to the same head.
    const { writer, reader } = await (async () => {
      let waiting;
      for (;;) {
        let a;
        let b;
        try {
          [a, b] = await Promise.all([
            status(options.writerStateDir, "preflight"),
            status(options.readerStateDir, "preflight")
          ]);
        } catch (error) {
          if (waiting && error instanceof CanaryError && error.code === "timeout") {
            throw new CanaryError("preflight", waiting);
          }
          throw error;
        }
        const writerState = device(a, "preflight");
        const readerState = device(b, "preflight");
        if (!a.account.account_id || a.account.account_id !== b.account.account_id) {
          throw new CanaryError("preflight", "account_mismatch");
        }
        if (!a.device?.device_id || a.device.device_id === b.device?.device_id) {
          throw new CanaryError("preflight", "same_device");
        }
        waiting = [writerState.account, readerState.account, writerState.sync, readerState.sync]
          .find((state) => state.waiting)?.waiting;
        if (!waiting && writerState.collection.sync.head_known !== readerState.collection.sync.head_known) {
          waiting = "heads_differ";
        }
        if (!waiting) return { writer: writerState.collection, reader: readerState.collection };
        if (deadline - performance.now() <= POLL_INTERVAL_MS) throw new CanaryError("preflight", waiting);
        await pause();
      }
    })();

    const startHead = writer.sync.head_known;
    const nonce = randomBytes(16).toString("hex");
    // Confirm the reader's copy can be checked before timing starts.
    await confinedPath(reader, options.probePath, "preflight", { requireFile: false });
    const observed = {};
    const readerHeads = [];
    const waitingOn = {};
    let targetHead;
    let stopped = false;
    const at = () => performance.now() - wrote;
    // Why a device could not make progress, kept to explain a timeout.
    const blocked = ({ account, sync }) => account.waiting
      ?? (["log_offline", "collection_opening", "collection_unavailable"].includes(sync.waiting)
        ? sync.waiting
        : undefined);
    const until = async (done, step) => {
      try {
        while (!done() && !stopped && performance.now() < deadline) {
          await step();
          if (done()) return;
          await pause();
        }
      } catch (error) {
        // The deadline running out during a call ends the wait; it is not the cause.
        if (error instanceof CanaryError && error.code === "timeout") return;
        stopped = true;
        throw error;
      }
    };

    wrote = performance.now();
    await writeProbe(writer, options.probePath, probeDocument(nonce));

    const results = await Promise.allSettled([
      until(() => observed.upload !== undefined || observed.apply !== undefined, async () => {
        const current = device(await status(options.writerStateDir, "probe"), "probe");
        waitingOn.writer = blocked(current);
        const time = at();
        const sync = current.collection.sync;
        if (!sync) return;
        if (observed.detect === undefined && (sync.pending > 0 || sync.head_known > startHead)) {
          observed.detect = time;
        }
        if (sync.pending === 0 && sync.head_known > startHead && sync.confirmed_through === sync.head_known) {
          observed.upload = time;
          targetHead = sync.head_known;
        }
      }),
      until(() => observed.apply !== undefined
          || (targetHead !== undefined && readerHeads.at(-1)?.[1] >= targetHead), async () => {
        const current = device(await status(options.readerStateDir, "probe"), "probe");
        waitingOn.reader = blocked(current);
        const head = current.collection.sync?.head_known;
        if (Number.isSafeInteger(head) && head !== readerHeads.at(-1)?.[1]) readerHeads.push([at(), head]);
      }),
      until(() => observed.apply !== undefined, async () => {
        const bytes = await readCollectionFile(reader, options.probePath, "probe").catch((error) => {
          // Absent until the reader first applies it.
          if (error instanceof CanaryError && error.code === "marker_missing") return undefined;
          throw error;
        });
        if (bytes?.toString("utf8").includes(nonce)) observed.apply = at();
      })
    ]);
    if (targetHead !== undefined) {
      observed.notify = readerHeads.find(([, head]) => head >= targetHead)?.[0];
    }

    const timings = stageTimings(observed);
    stages = timings.stages;
    if (timings.missing) {
      const rejected = results.find((result) => result.status === "rejected")?.reason;
      const code = rejected instanceof CanaryError
        ? rejected.code
        : rejected
          ? "internal_error"
          : (["detect", "upload"].includes(timings.missing) ? waitingOn.writer : waitingOn.reader)
            ?? "timeout";
      stages.push({
        name: timings.missing,
        status: "failed",
        duration_ms: Math.max(0, Math.round(at() - timings.reachedAt))
      });
      throw new CanaryError(timings.missing, code);
    }
  } catch (error) {
    failure = error instanceof CanaryError ? error : new CanaryError("internal", "internal_error");
    // A failure before timing started is the run's one stage: the timings
    // contract needs at least one.
    if (stages.length === 0) stages = [{ name: failure.stage, status: "failed", duration_ms: elapsed(started) }];
  }

  return {
    exitCode: failure?.exitCode ?? 0,
    options,
    result: {
      schema_version: 1,
      source: "sync",
      component: "hosted",
      environment,
      checked_at: checkedAt,
      status: failure ? "failed" : "operational",
      // From the write to the reader's copy (or the failed stage); a run that
      // failed before timing started reports how long it took.
      duration_ms: stages.reduce((sum, stage) => sum + stage.duration_ms, 0),
      stages,
      ...(failure ? { error: { stage: failure.stage, code: failure.code } } : {})
    }
  };
}

/** POST one result to the ops timings endpoint. Returns a fixed failure description or nothing. */
export async function publishTimings(result, { timingsUrl, timingsTokenFile }) {
  let token;
  try {
    const entry = await lstat(timingsTokenFile);
    if (!entry.isFile() || (entry.mode & 0o077) !== 0 || entry.size > MAX_TOKEN_BYTES) {
      return "token file must be a private regular file";
    }
    token = (await readFile(timingsTokenFile, "utf8")).trim();
  } catch {
    return "token file is unreadable";
  }
  if (!/^[\x21-\x7e]+$/u.test(token)) return "token file is malformed";
  let response;
  try {
    response = await fetch(timingsUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(result),
      redirect: "error",
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS)
    });
  } catch {
    return "endpoint unreachable";
  }
  // Drain the body without reflecting it.
  await response.arrayBuffer().catch(() => {});
  return response.ok ? undefined : `HTTP ${response.status}`;
}

async function main() {
  const { exitCode, options, result } = await runCanary();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
  if (options?.timingsUrl) {
    const problem = await publishTimings(result, options);
    if (problem) {
      process.stderr.write(`Timing publication failed: ${problem}.\n`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
