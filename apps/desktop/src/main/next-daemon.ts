import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions } from "./update-policy";

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
  /** The bundled version did not become ready; `version` is the restored previous one. */
  | { outcome: "rolled_back"; version: string; failed: string; reason: string };

export interface EnsureOptions {
  /** The previous runtime copy's CLI, when `mdbase.previous` exists. */
  rollback?: CliRunner | null;
  /** A bundled version that already failed and was rolled back: don't retry it. */
  heldBack?: string | null;
}

interface ServiceStatus {
  registration: unknown;
  binary_version?: unknown;
  readiness?: { ready?: unknown; binary_version?: unknown } | null;
}

function serviceStatus(result: CliResult, command: string): ServiceStatus {
  if (result.exitCode !== 0 && result.exitCode !== 3) {
    throw new Error(`mdbase service ${command} failed (exit ${result.exitCode}).`);
  }
  if (!result.value) throw new Error(`mdbase service ${command} returned no status.`);
  return result.value as unknown as ServiceStatus;
}

function installedVersion(status: ServiceStatus): string | null {
  const version = typeof status.binary_version === "string"
    ? status.binary_version
    : typeof status.readiness?.binary_version === "string"
      ? status.readiness.binary_version
      : null;
  return version;
}

function atLeast(version: string | null, bundled: string): boolean {
  if (!version) return false;
  try {
    return compareVersions(version, bundled) >= 0;
  } catch {
    return false;
  }
}

/** Registered and ready, running `version` (any version when omitted). */
function healthy(value: Record<string, unknown> | null, version?: string): value is Record<string, unknown> & ServiceStatus {
  const health = value as ServiceStatus | null;
  return !!health && health.registration === "installed" && health.readiness?.ready === true &&
    typeof health.readiness.binary_version === "string" &&
    (version === undefined || health.readiness.binary_version === version);
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
  if (status.registration === "installed" && version &&
      (atLeast(version, bundledVersion) || options.heldBack === bundledVersion)) {
    if (status.readiness === null || status.readiness === undefined) {
      const started = await run(["--json", "service", "start"]);
      if (started.exitCode !== 0) throw new Error(`mdbase service start failed (exit ${started.exitCode}).`);
      if (!healthy(started.value, version)) {
        throw new Error("The installed mdbase daemon did not become ready after starting.");
      }
      return { outcome: "already_installed", version, started: true };
    }
    return { outcome: "already_installed", version, started: false };
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
  if (restored.exitCode !== 0 || !healthy(restored.value)) {
    throw new Error(`${failure.message} Restoring the previous mdbase daemon also failed.`);
  }
  return {
    outcome: "rolled_back",
    version: restored.value.readiness!.binary_version as string,
    failed: bundledVersion,
    reason: failure.message
  };
}

async function installBundled(run: CliRunner, bundledVersion: string): Promise<NextDaemonOutcome> {
  const installed = await run(["--json", "service", "install"]);
  if (installed.exitCode !== 0) {
    throw new Error(
      installed.exitCode === 2
        ? "mdbase refused to install its service for this profile."
        : installed.exitCode === 3
          ? "The mdbase daemon was installed but did not become ready."
          : `mdbase service install failed (exit ${installed.exitCode}).`
    );
  }
  if (!healthy(installed.value, bundledVersion)) {
    throw new Error("The mdbase daemon did not report a healthy installation of the bundled version.");
  }
  return { outcome: "installed", version: bundledVersion };
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
