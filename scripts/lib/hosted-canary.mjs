// Shared by the hosted canaries (`scripts/hosted-read-canary.mjs` and
// `scripts/hosted-sync-canary.mjs`): input parsing, CLI invocation, the
// account and collection checks on `mdbase status --json`, and confined file
// reads. Only fixed codes cross a canary's output boundary.

import { execFile } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
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
export const OVERRIDES = ["MDBASE_HOME", "MDBASE_ENV", "MDBASE_SECRET_BACKEND"];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export class CanaryError extends Error {
  constructor(stage, code, exitCode = 1) {
    super(code);
    this.stage = stage;
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function configError(code = "invalid_config") {
  return new CanaryError("config", code, 2);
}

/**
 * `--name value` pairs and their environment-variable forms (`inputs` maps a
 * name to its variable). Each input comes from exactly one of the two.
 */
export function inputReader(argv, environmentVariables, inputs) {
  const supplied = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw configError();
    }
    const name = flag.slice(2);
    if (!Object.hasOwn(inputs, name) || supplied.has(name)) throw configError();
    supplied.set(name, value);
  }
  const optional = (name) => {
    const argument = supplied.get(name);
    const environmentValue = environmentVariables[inputs[name]];
    if (argument !== undefined && environmentValue !== undefined) throw configError();
    const result = argument ?? environmentValue;
    return result === "" ? undefined : result;
  };
  return {
    optional,
    value(name) {
      const result = optional(name);
      if (result === undefined) throw configError();
      return result;
    }
  };
}

/** The environment label to report even when the rest of the input is invalid. */
export function reportedEnvironment(argv, environmentVariables, variable) {
  const index = argv.indexOf("--environment");
  const supplied = index === -1 ? environmentVariables[variable] : argv[index + 1];
  return ENVIRONMENT.test(supplied ?? "") ? supplied : "unknown";
}

/** A collection-relative path with no empty, `.` or `..` segments. */
export function isCollectionPath(path) {
  return path.length <= 1024
    && !posix.isAbsolute(path)
    && !path.includes("\\")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function isOrigin(text) {
  try {
    const parsed = new URL(text);
    return ["https:", "http:"].includes(parsed.protocol) && parsed.origin === text;
  } catch {
    return false;
  }
}

export function isTimeout(text) {
  const value = Number(text);
  return /^[1-9][0-9]*$/u.test(text) && Number.isSafeInteger(value) && value <= 300_000;
}

export function elapsed(started) {
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

/** Run `cli --state-dir <dir> --json ...` and parse its JSON output. */
export async function runCli({ cli, stateDir, environmentVariables }, stage, argumentsList, timeout) {
  try {
    const { stdout } = await execFileAsync(
      cli,
      ["--state-dir", stateDir, "--json", ...argumentsList],
      { env: environmentVariables, timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) throw new CanaryError(stage, "malformed_json");
    throw new CanaryError(stage, cliFailureCode(error));
  }
}

/** Whether a daemon's account is keyring-backed, signed in at `expectedOrigin` and online. */
export function accountState(status, { expectedOrigin }) {
  const account = status?.account;
  if (status?.secret_backend !== "keychain") return { terminal: "insecure_secret_backend" };
  if (account?.signed_in !== true || account.pairing) return { terminal: "not_signed_in" };
  if (account.server !== expectedOrigin) return { terminal: "origin_mismatch" };
  if (account.last_error) {
    return { waiting: ACCOUNT_ERRORS.has(account.last_error) ? account.last_error : "account_error" };
  }
  // The relay is a device-bound, authenticated control-plane session.
  if (account.online !== true) return { waiting: "account_offline" };
  return { done: true };
}

/** The one registered collection with the expected ID, name and hosted log. */
export function collectionOf(status, { collectionId, expectedCollectionName }, stage) {
  const matching = Array.isArray(status?.collections)
    ? status.collections.filter((item) => item?.id === collectionId)
    : [];
  if (matching.length !== 1) throw new CanaryError(stage, "missing_collection");
  const collection = matching[0];
  if (collection.name !== expectedCollectionName
      || collection.mode !== "synced"
      || collection.log !== "hosted") {
    throw new CanaryError(stage, "collection_mismatch");
  }
  return collection;
}

/** Whether a collection is open, online to its hosted log and caught up. */
export function syncState(collection) {
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

/**
 * Resolve a collection-relative path inside the collection's real root,
 * refusing symlinks that leave it. `requireFile` also requires an existing
 * regular file; otherwise only the parent directory must exist.
 */
export async function confinedPath(collection, relativePath, stage, { requireFile = true } = {}) {
  if (typeof collection.root !== "string" || !isAbsolute(collection.root)) {
    throw new CanaryError(stage, "invalid_response");
  }
  try {
    const root = await realpath(collection.root);
    const target = resolve(root, ...relativePath.split("/"));
    const parent = await realpath(resolve(target, ".."));
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) {
      throw new CanaryError(stage, "marker_mismatch");
    }
    const entry = await lstat(target).catch((error) => {
      if (error?.code === "ENOENT" && !requireFile) return undefined;
      throw error;
    });
    if (entry && !entry.isFile()) throw new CanaryError(stage, "marker_mismatch");
    if (entry && entry.size > MAX_FILE_BYTES) throw new CanaryError(stage, "marker_too_large");
    return target;
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    throw new CanaryError(stage, error?.code === "ENOENT" ? "marker_missing" : "marker_unreadable");
  }
}

/** A regular file's bytes from inside a collection, without following a final symlink. */
export async function readCollectionFile(collection, relativePath, stage) {
  const target = await confinedPath(collection, relativePath, stage);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new CanaryError(stage, "marker_too_large");
    return bytes;
  } catch (error) {
    if (error instanceof CanaryError) throw error;
    throw new CanaryError(stage, error?.code === "ENOENT" ? "marker_missing" : "marker_unreadable");
  } finally {
    await handle?.close();
  }
}
