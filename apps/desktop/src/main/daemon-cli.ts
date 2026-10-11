import { execFile } from "node:child_process";
import { join } from "node:path";
import { DaemonControlError, parseEndpoint, type DaemonEndpoint } from "./daemon-client";

/**
 * Running the mdbase daemon's CLI (mdbase-next `crates/daemon/src/cli.rs`).
 *
 * Privileged control methods (sign-in, migrate start, sync enable, approvals, …)
 * need the control key in the OS keychain. The app never reads it: it runs the
 * daemon's own CLI, which authenticates itself. `--json` prints the result object,
 * or `{"error": {code, message, reason?}}`. Exit codes: 0 ok, 1 error, 2 usage,
 * 3 not running or not ready.
 */

export const CLI_TIMEOUT_MS = 60_000;

export type DaemonTarget = "installed_service" | "isolated_profile";

/** Which daemon profile the app drives. */
export interface DaemonProfile {
  target: DaemonTarget;
  stateDir: string;
  control: DaemonEndpoint;
}

export interface CliOutcome {
  exitCode: number;
  value: unknown;
}

export type CliExec = (binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<CliOutcome>;

/** Arguments selecting the profile: an isolated profile always names its state dir. */
export function profileArguments(profile: Pick<DaemonProfile, "target" | "stateDir">): string[] {
  return profile.target === "isolated_profile" ? ["--state-dir", profile.stateDir] : [];
}

/**
 * The CLI environment. The installed profile must never inherit `MDBASE_HOME`
 * (it would silently select another profile). Test-only secret backends are only
 * honoured by debug daemon builds, so they are passed through unchanged.
 */
export function cliEnvironment(target: DaemonTarget, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...environment };
  if (target === "installed_service") delete env.MDBASE_HOME;
  return env;
}

export function parseProfile(value: unknown): DaemonProfile {
  const v = value as { target?: unknown; state_dir?: unknown; control?: unknown } | null;
  if (!v || (v.target !== "installed_service" && v.target !== "isolated_profile") ||
      typeof v.state_dir !== "string" || !v.state_dir) {
    throw new Error("The mdbase daemon returned invalid profile paths.");
  }
  return { target: v.target, stateDir: v.state_dir, control: parseEndpoint(v.control) };
}

/** The installed profile's registered runtime copy (`service install` puts it there). */
export function runtimeBinary(stateDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(stateDir, "runtime", `mdbase${platform === "win32" ? ".exe" : ""}`);
}

export const execCli: CliExec = (binary, args, env, timeoutMs) => new Promise((resolve) => {
  execFile(binary, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout) => {
      const exitCode = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      let value: unknown = null;
      try {
        value = JSON.parse(String(stdout));
      } catch {
        value = null;
      }
      resolve({ exitCode, value });
    });
});

export class DaemonCli {
  constructor(
    private readonly binary: () => string,
    private readonly target: DaemonTarget,
    private readonly stateDir: string | null,
    private readonly exec: CliExec = execCli,
    private readonly environment: NodeJS.ProcessEnv = process.env
  ) {}

  /** Discover the profile (`mdbase --json paths`). */
  static async discover(
    binary: string,
    isolatedStateDir: string | null,
    exec: CliExec = execCli,
    environment: NodeJS.ProcessEnv = process.env
  ): Promise<DaemonProfile> {
    const target: DaemonTarget = isolatedStateDir ? "isolated_profile" : "installed_service";
    const args = [...(isolatedStateDir ? ["--state-dir", isolatedStateDir] : []), "--json", "paths"];
    const outcome = await exec(binary, args, cliEnvironment(target, environment), 10_000);
    if (outcome.exitCode !== 0) throw new Error(`mdbase paths failed (exit ${outcome.exitCode}).`);
    const profile = parseProfile(outcome.value);
    if (profile.target !== target) throw new Error("The mdbase daemon selected an unexpected profile.");
    return profile;
  }

  /** Run `mdbase [--state-dir …] --json <args>`; the result object, or a typed error. */
  async run<T = unknown>(args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<T> {
    const full = [
      ...profileArguments({ target: this.target, stateDir: this.stateDir ?? "" }),
      "--json",
      ...args
    ];
    const outcome = await this.exec(this.binary(), full, cliEnvironment(this.target, this.environment), timeoutMs);
    const value = outcome.value as { error?: { code?: unknown; message?: unknown; reason?: unknown } } | null;
    if (outcome.exitCode === 0 && value !== null) return value as T;
    const error = value && typeof value === "object" ? value.error : undefined;
    if (error && typeof error === "object") {
      throw new DaemonControlError(
        typeof error.code === "string" ? error.code : "internal",
        typeof error.message === "string" ? error.message : `mdbase ${args[0]} failed.`,
        typeof error.reason === "string" ? error.reason : undefined
      );
    }
    throw new DaemonControlError(
      outcome.exitCode === 3 ? "unavailable" : "internal",
      outcome.exitCode === -1
        ? `mdbase ${args.join(" ")} did not finish.`
        : `mdbase ${args.join(" ")} failed (exit ${outcome.exitCode}).`
    );
  }
}
