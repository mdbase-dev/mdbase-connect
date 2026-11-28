import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { previousRuntimeBinary, runtimeBinary } from "./daemon-cli";
import { CONTROL_PROTOCOL } from "./daemon-client";
import { compareVersions } from "./update-policy";
import type { UpdateStateStore } from "./update-state";

/**
 * Keeping the installed mdbase daemon at the version this app bundles.
 *
 * The app update delivers the daemon: each app version ships `Resources/mdbase-next`,
 * and on launch `mdbase service install` swaps it into `<state>/runtime/mdbase`,
 * keeping the replaced copy as `mdbase.previous`. If the new copy does not become
 * ready, the previous copy installs itself again and this bundled version is held
 * back until the next app update. The old connector is never started or stopped
 * here; the daemon's takeover owns that.
 */

export const NEXT_DAEMON_TIMEOUT_MS = 60_000;

export interface CliResult {
  exitCode: number;
  value: Record<string, unknown> | null;
}

export type CliRunner = (args: string[]) => Promise<CliResult>;

export type NextDaemonOutcome =
  | { outcome: "already_installed"; version: string; started: boolean }
  | { outcome: "installed"; version: string }
  | { outcome: "attached"; version: string }
  | { outcome: "started_direct"; version: string }
  /** The bundled version did not become ready; `version` is the restored previous one. */
  | { outcome: "rolled_back"; version: string; failed: string; reason: string };

export interface EnsureOptions {
  /** The previous runtime copy's CLI, when `mdbase.previous` exists. */
  rollback?: CliRunner | null;
  /** A bundled version that already failed and was rolled back: don't retry it. */
  heldBack?: string | null;
  /** GUI-only Linux startup without a user service manager. */
  startDirect?: (version: string, source: "bundle" | "registered") => Promise<void>;
}

interface ServiceStatus {
  registration: unknown;
  binary_version?: unknown;
  manager_unavailable?: unknown;
  readiness?: {
    ready?: unknown;
    binary_version?: unknown;
    schema_version?: unknown;
    control_protocol?: unknown;
  } | null;
}

/**
 * A failed `mdbase service` command, with the CLI's own error message when it
 * printed one: for example, which service-manager call failed and why.
 */
function serviceFailure(command: string, result: CliResult): Error {
  const error = result.value?.error as { message?: unknown } | undefined;
  return new Error(typeof error?.message === "string" && error.message
    ? `mdbase service ${command} failed: ${error.message}`
    : `mdbase service ${command} failed (exit ${result.exitCode}).`);
}

function serviceStatus(result: CliResult, command: string): ServiceStatus {
  if (result.exitCode !== 0 && result.exitCode !== 3) throw serviceFailure(command, result);
  if (!result.value) throw new Error(`mdbase service ${command} returned no status.`);
  return result.value as unknown as ServiceStatus;
}

function installedVersion(status: ServiceStatus): string | null {
  return status.registration === "installed" && typeof status.binary_version === "string"
    ? status.binary_version : null;
}

function atLeast(version: string | null, bundled: string): boolean {
  if (!version) return false;
  try {
    return compareVersions(version, bundled) >= 0;
  } catch {
    return false;
  }
}

export function compatibleVersion(readiness: ServiceStatus["readiness"]): string | null {
  const version = readiness?.binary_version;
  return readiness?.schema_version === 1 && readiness.control_protocol === CONTROL_PROTOCOL &&
    typeof version === "string" && atLeast(version, version) ? version : null;
}

function healthyInstalledVersion(result: CliResult): string | null {
  const status = result.value as ServiceStatus | null;
  return result.exitCode === 0 && status?.registration === "installed" && status.readiness?.ready === true
    ? compatibleVersion(status.readiness) : null;
}

/**
 * Install the bundled daemon unless an equal or newer one (it updates itself) or a
 * held-back fallback is registered; start it if registered but not running. If the
 * swapped-in bundle does not become ready, restore `mdbase.previous`.
 */
export async function ensureNextDaemon(
  run: CliRunner,
  bundledVersion: string,
  options: EnsureOptions = {}
): Promise<NextDaemonOutcome> {
  const status = serviceStatus(await run(["--json", "service", "status"]), "status");
  const version = installedVersion(status);
  const held = options.heldBack === bundledVersion;
  const keepRegistered = version !== null && (atLeast(version, bundledVersion) || held);
  const running = compatibleVersion(status.readiness);
  const managerUnavailable = status.manager_unavailable === true;

  // Registration describes what the manager would start. The socket answers
  // for the daemon Desktop will actually use. With a manager and no valid
  // registration, keep the normal install path so the service starts at login.
  if (running && (managerUnavailable || status.registration === "installed") &&
      (atLeast(running, bundledVersion) || (keepRegistered && running === version))) {
    return !managerUnavailable && running === version
      ? { outcome: "already_installed", version: running, started: false }
      : { outcome: "attached", version: running };
  }

  if (managerUnavailable) {
    const directVersion = keepRegistered ? version : bundledVersion;
    if (status.readiness) {
      throw new Error("The user systemd session is unavailable and another mdbase daemon is running. Stop it with `mdbase daemon stop` and relaunch Desktop to update it.");
    }
    if (!options.startDirect) {
      throw new Error("The user systemd session is unavailable. Launch Desktop to start mdbase for the session.");
    }
    await options.startDirect(directVersion, directVersion === bundledVersion ? "bundle" : "registered");
    return { outcome: "started_direct", version: directVersion };
  }
  if (keepRegistered) {
    if (status.readiness) {
      if (!running) throw new Error("The installed mdbase daemon uses an incompatible control protocol.");
      return { outcome: "attached", version: running };
    }
    const started = await run(["--json", "service", "start"]);
    if (started.exitCode !== 0) throw serviceFailure("start", started);
    if (healthyInstalledVersion(started) !== version) {
      throw new Error("The installed mdbase daemon did not become ready after starting.");
    }
    return { outcome: "already_installed", version, started: true };
  }
  let failure: Error;
  try {
    return await installBundled(run, bundledVersion);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  if (!options.rollback) throw failure;
  // Roll back only a completed swap: the registered runtime is now the bundled copy.
  const after = await run(["--json", "service", "status"]).catch(() => null);
  if (!after?.value || installedVersion(after.value as unknown as ServiceStatus) !== bundledVersion) throw failure;
  const restored = await options.rollback(["--json", "service", "install"]);
  const restoredVersion = healthyInstalledVersion(restored);
  if (!restoredVersion) {
    throw new Error(`${failure.message} Restoring the previous mdbase daemon also failed.`);
  }
  return {
    outcome: "rolled_back",
    version: restoredVersion,
    failed: bundledVersion,
    reason: failure.message
  };
}

async function installBundled(run: CliRunner, bundledVersion: string): Promise<NextDaemonOutcome> {
  const installed = await run(["--json", "service", "install"]);
  if (installed.exitCode === 2) throw new Error("mdbase refused to install its service for this profile.");
  if (installed.exitCode === 3) throw new Error("The mdbase daemon was installed but did not become ready.");
  if (installed.exitCode !== 0) throw serviceFailure("install", installed);
  if (healthyInstalledVersion(installed) !== bundledVersion) {
    throw new Error("The mdbase daemon did not report a healthy installation of the bundled version.");
  }
  return { outcome: "installed", version: bundledVersion };
}

/**
 * [`ensureNextDaemon`] for the installed profile, with the held-back version kept
 * in the app's update state. `holding` is true while the bundled version is held
 * back and `result.version` (an older one) keeps running.
 */
export async function ensureBundledDaemon(
  store: UpdateStateStore,
  bundled: BundledNextDaemon,
  stateDir: string,
  startDirect?: (binary: string, version: string) => Promise<void>
): Promise<{ result: NextDaemonOutcome; holding: boolean }> {
  const held = (await store.load()).daemon_held_back;
  const previous = previousRuntimeBinary(stateDir);
  const result = await ensureNextDaemon(nextDaemonRunner(bundled.binary), bundled.version, {
    heldBack: held?.version,
    rollback: existsSync(previous) ? nextDaemonRunner(previous) : null,
    startDirect: startDirect && ((version, source) =>
      startDirect(source === "bundle" ? bundled.binary : runtimeBinary(stateDir), version))
  });
  if (result.outcome === "rolled_back") {
    await store.update((state) => {
      state.daemon_held_back = { version: result.failed, reason: result.reason };
    });
  } else if (held && atLeast(result.version, bundled.version)) {
    await store.update((state) => {
      delete state.daemon_held_back;
    });
  }
  const holding = result.outcome === "rolled_back" ||
    (held?.version === bundled.version && !atLeast(result.version, bundled.version));
  return { result, holding };
}

/** The bundled daemon, next to (never over) the old connector binary. */
export interface BundledNextDaemon {
  binary: string;
  version: string;
}

export async function bundledNextDaemon(
  resourcesPath: string,
  platform: NodeJS.Platform
): Promise<BundledNextDaemon | null> {
  const directory = join(resourcesPath, "mdbase-next");
  const binary = join(directory, `mdbase${platform === "win32" ? ".exe" : ""}`);
  if (!existsSync(binary)) return null;
  const version = (await readFile(join(directory, "VERSION"), "utf8")).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("The bundled mdbase daemon has an invalid version file.");
  }
  return { binary, version };
}

/**
 * Run the bundled CLI with the installed profile: never `--state-dir` and
 * never `MDBASE_HOME`, so the service lands in mdbase's own state directory.
 */
export function nextDaemonRunner(binary: string, environment: NodeJS.ProcessEnv = process.env): CliRunner {
  const env = { ...environment };
  delete env.MDBASE_HOME;
  return (args) => new Promise((resolve) => {
    execFileCallback(binary, args, { env, timeout: NEXT_DAEMON_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      let value: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(String(stdout)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          value = parsed as Record<string, unknown>;
        }
      } catch {
        value = null;
      }
      resolve({ exitCode, value });
    });
  });
}
