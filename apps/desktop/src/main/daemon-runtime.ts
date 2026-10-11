import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { bundledNextDaemon } from "./next-daemon";

/**
 * Which mdbase daemon binary and profile the app uses.
 *
 * - Packaged: the bundled `Resources/mdbase-next/mdbase[.exe]` + `VERSION`, installed
 *   profile only. Development overrides are ignored.
 * - Development: `MDBN_DAEMON_BIN` (an mdbn-daemon build) is required. With
 *   `MDBASE_DESKTOP_STATE_DIR` the app drives an isolated profile there and never
 *   touches the OS service manager; the daemon then only looks for old connector state
 *   at an explicit `MDBASE_CONNECT_HOME`.
 */

export interface DaemonRuntime {
  binary: string;
  version: string;
  /** Isolated profile state directory, or null for the installed profile. */
  isolatedStateDir: string | null;
}

export async function resolveDaemonRuntime(options: {
  packaged: boolean;
  resourcesPath: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  version?: (binary: string) => Promise<string>;
}): Promise<DaemonRuntime> {
  if (options.packaged) {
    const bundled = await bundledNextDaemon(options.resourcesPath, options.platform);
    if (!bundled) throw new Error("This installation is missing its mdbase daemon. Reinstall mdbase.");
    return { ...bundled, isolatedStateDir: null };
  }
  const binary = options.env.MDBN_DAEMON_BIN;
  if (!binary || !isAbsolute(binary) || !existsSync(binary)) {
    throw new Error("Set MDBN_DAEMON_BIN to an absolute path of an mdbn-daemon `mdbase` build.");
  }
  const stateDir = options.env.MDBASE_DESKTOP_STATE_DIR;
  if (stateDir !== undefined && !isAbsolute(stateDir)) {
    throw new Error("MDBASE_DESKTOP_STATE_DIR must be an absolute path.");
  }
  return {
    binary,
    version: await (options.version ?? binaryVersion)(binary),
    isolatedStateDir: stateDir ?? null
  };
}

/** `mdbase --version` → `0.2.0` (the last word). */
export function binaryVersion(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["--version"], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      const version = String(stdout).trim().split(/\s+/).at(-1);
      if (error || !version) reject(new Error(`Could not read the version of ${binary}.`));
      else resolve(version);
    });
  });
}
