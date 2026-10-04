import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions } from "./update-policy";

/**
 * Installing the bundled mdbase-next daemon from the bridge release
 * (mdbase-next packaging interface, 2026-10-04, section 6.7).
 *
 * The bridge never stops or disables the old connector itself: the new
 * daemon's takeover (T1) does that. This module only registers and starts the
 * new daemon's own service, in its own state directory and unit names.
 */

export const NEXT_DAEMON_TIMEOUT_MS = 60_000;

export interface CliResult {
  exitCode: number;
  value: Record<string, unknown> | null;
}

export type CliRunner = (args: string[]) => Promise<CliResult>;

export type NextDaemonOutcome =
  | { outcome: "already_installed"; version: string; started: boolean }
  | { outcome: "installed"; version: string };

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

/**
 * Install the bundled daemon unless an equal or newer one (it updates itself)
 * is already registered; start it if registered but not running. Healthy
 * means exit 0, registered, ready, and running the bundled version.
 */
export async function ensureNextDaemon(run: CliRunner, bundledVersion: string): Promise<NextDaemonOutcome> {
  const status = serviceStatus(await run(["--json", "service", "status"]), "status");
  if (status.registration === "installed" && atLeast(installedVersion(status), bundledVersion)) {
    const version = installedVersion(status)!;
    if (status.readiness === null || status.readiness === undefined) {
      const started = await run(["--json", "service", "start"]);
      if (started.exitCode !== 0) throw new Error(`mdbase service start failed (exit ${started.exitCode}).`);
      const health = started.value as ServiceStatus | null;
      if (!health || health.registration !== "installed" || health.readiness?.ready !== true ||
          !atLeast(typeof health.readiness.binary_version === "string" ? health.readiness.binary_version : null, bundledVersion)) {
        throw new Error("The installed mdbase daemon did not become ready after starting.");
      }
      return { outcome: "already_installed", version, started: true };
    }
    return { outcome: "already_installed", version, started: false };
  }
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
  const health = installed.value as ServiceStatus | null;
  if (
    !health || health.registration !== "installed" || health.readiness?.ready !== true ||
    health.readiness.binary_version !== bundledVersion
  ) {
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

/** Whether Connect's rollout allows this account's local takeover. Closed on any doubt. */
export function rolloutAllowsLocalTakeover(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).local_takeover === true;
}
