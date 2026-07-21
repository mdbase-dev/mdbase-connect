import type { ChildProcess } from "node:child_process";

export async function stopAgentProcess(
  agent: ChildProcess | null,
  gracefulTimeoutMs = 2_000
): Promise<void> {
  if (!agent || agent.exitCode !== null || agent.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    let forceTimer: NodeJS.Timeout | undefined;
    let failureTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (forceTimer) clearTimeout(forceTimer);
      if (failureTimer) clearTimeout(failureTimer);
      agent.removeListener("exit", exited);
    };
    const exited = () => {
      cleanup();
      resolve();
    };

    agent.once("exit", exited);
    if (!agent.kill()) {
      cleanup();
      resolve();
      return;
    }

    forceTimer = setTimeout(() => {
      if (agent.exitCode !== null || agent.signalCode !== null) {
        exited();
        return;
      }
      agent.kill("SIGKILL");
      failureTimer = setTimeout(() => {
        cleanup();
        reject(new Error("The local connector did not stop before the application restart."));
      }, 1_000);
    }, gracefulTimeoutMs);
  });
}

export async function relaunchAfterAgentStops(
  agent: ChildProcess | null,
  relaunch: () => void,
  exit: () => void
): Promise<void> {
  await stopAgentProcess(agent);
  relaunch();
  exit();
}
