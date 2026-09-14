import { presentReadiness, type AgentReadiness } from "../shared/readiness";
export { presentReadiness } from "../shared/readiness";

export interface AgentPing {
  pong: boolean;
  ready?: boolean;
  readiness?: AgentReadiness;
}

export interface AgentStartupOptions {
  ping(timeoutMs: number): Promise<AgentPing>;
  launch(): Promise<void>;
  endpointIsUnavailable(error: unknown): boolean;
  incompatibleDaemon(error: unknown): boolean;
  expectedVersion: string;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
}

class ReadinessError extends Error {}

function isReady(ping: AgentPing, options: AgentStartupOptions): boolean {
  const health = presentReadiness(ping.readiness, options.expectedVersion);
  if (!ping.pong || health.state === "attention") throw new ReadinessError(health.label);
  return health.state === "ready";
}

const terminal = (error: unknown, options: AgentStartupOptions) =>
  error instanceof ReadinessError || options.incompatibleDaemon(error);
const delay = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

export async function waitForAgentReady(options: AgentStartupOptions): Promise<void> {
  const deadline = Date.now() + (options.readinessTimeoutMs ?? 60_000);
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  while (Date.now() < deadline) {
    try {
      if (isReady(await options.ping(500), options)) return;
    } catch (error) {
      if (terminal(error, options)) throw error;
      // The process may still be binding its local endpoint.
    }
    await delay(pollIntervalMs);
  }
  throw new Error("The local connector did not finish starting in time.");
}

export async function ensureAgentReady(options: AgentStartupOptions): Promise<void> {
  try {
    if (isReady(await options.ping(400), options)) return;
    return waitForAgentReady(options);
  } catch (error) {
    if (terminal(error, options)) throw error;
    if (!options.endpointIsUnavailable(error)) return waitForAgentReady(options);
  }

  try {
    await options.launch();
  } catch (launchError) {
    try {
      if (isReady(await options.ping(500), options)) return;
    } catch (probeError) {
      if (terminal(probeError, options)) throw probeError;
      if (options.endpointIsUnavailable(probeError)) throw launchError;
    }
    // A service can still be scanning after the CLI's startup budget expires.
    return waitForAgentReady(options);
  }
  await waitForAgentReady(options);
}
