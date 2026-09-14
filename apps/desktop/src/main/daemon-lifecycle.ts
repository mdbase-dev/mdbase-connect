import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function launchDaemon(binary: string, paths: DaemonPaths, packaged: boolean): Promise<void> {
  if (!existsSync(binary)) throw new Error(`Connector runtime is missing: ${binary}`);
  await mkdir(paths.stateDir, { recursive: true });
  await execFile(binary, daemonCliArguments(paths.target, paths.stateDir, paths.endpoint, ["start"]), {
    env: connectCliEnvironment(packaged), timeout: 30_000, windowsHide: true
  });
}

export function connectCliEnvironment(
  packaged: boolean,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (!packaged) return environment;
  const sanitized = { ...environment };
  delete sanitized.MDBASE_CONNECT_HOME;
  delete sanitized.MDBASE_CONNECT_SOCKET;
  return sanitized;
}

export type DaemonTarget = "installed_service" | "isolated_profile";
export interface DaemonPaths { stateDir: string; endpoint: string; target: DaemonTarget }

export function parseDaemonPaths(value: unknown): DaemonPaths {
  const paths = value as { state_dir?: unknown; endpoint?: unknown; target?: unknown } | null;
  if (!paths || typeof paths.state_dir !== "string" || typeof paths.endpoint !== "string" ||
      (paths.target !== "installed_service" && paths.target !== "isolated_profile")) {
    throw new Error("The connector runtime returned invalid path information.");
  }
  return { stateDir: paths.state_dir, endpoint: paths.endpoint, target: paths.target };
}

export function daemonCliArguments(
  target: DaemonTarget,
  stateDirectory: string,
  endpoint: string,
  command: string[],
  json = false
): string[] {
  return [
    ...(target === "isolated_profile" ? ["--state-dir", stateDirectory, "--endpoint", endpoint] : []),
    ...(json ? ["--json"] : []),
    "connect",
    "daemon",
    ...command
  ];
}
