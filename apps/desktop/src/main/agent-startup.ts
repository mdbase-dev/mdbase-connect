export interface AgentPing {
  pong: boolean;
  ready?: boolean;
}

export interface AgentStartupOptions {
  ping(timeoutMs: number): Promise<AgentPing>;
  launch(): Promise<void>;
  endpointIsUnavailable(error: unknown): boolean;
  incompatibleDaemon(error: unknown): boolean;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
}

const delay = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

export async function waitForAgentReady(options: AgentStartupOptions): Promise<void> {
  const deadline = Date.now() + (options.readinessTimeoutMs ?? 60_000);
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  while (Date.now() < deadline) {
    try {
      const ping = await options.ping(500);
      if (ping.ready !== false) return;
    } catch (error) {
      if (options.incompatibleDaemon(error)) throw error;
      // The process may still be binding its local endpoint.
    }
    await delay(pollIntervalMs);
  }
  throw new Error("The local connector did not finish starting in time.");
}

export async function ensureAgentReady(options: AgentStartupOptions): Promise<void> {
  try {
    const ping = await options.ping(400);
    if (ping.ready !== false) return;
    return waitForAgentReady(options);
  } catch (error) {
    if (options.incompatibleDaemon(error)) throw error;
    if (!options.endpointIsUnavailable(error)) return waitForAgentReady(options);
  }

  try {
    await options.launch();
  } catch (launchError) {
    try {
      const ping = await options.ping(500);
      if (ping.ready !== false) return;
    } catch (probeError) {
      if (options.incompatibleDaemon(probeError)) throw probeError;
      if (options.endpointIsUnavailable(probeError)) throw launchError;
    }
    // Starting a persistent service and waiting for its collection scan are
    // separate operations. The CLI can time out while the service continues
    // initializing, so keep polling an endpoint that is already available.
    return waitForAgentReady(options);
  }

  await waitForAgentReady(options);
}
