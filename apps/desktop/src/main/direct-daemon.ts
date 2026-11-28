import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { daemonNotRunning, requestDaemon, type DaemonEndpoint } from "./daemon-client";
import { cliEnvironment } from "./daemon-cli";
import type { Readiness } from "./daemon-session";
import { compatibleVersion } from "./next-daemon";

/** Owns only the foreground daemon Desktop starts when user systemd is absent. */
export class DirectDaemon {
  private run: { child: ChildProcess; exited: Promise<number | string | null> } | null = null;
  private stopped = false;

  constructor(private readonly control: DaemonEndpoint) {}

  async start(binary: string, version: string): Promise<void> {
    if (this.stopped) throw new Error("Desktop is quitting.");
    if (this.run) throw new Error("Desktop already started an mdbase daemon for this session.");
    const child = spawn(binary, ["daemon", "run"], {
      env: cliEnvironment("installed_service"),
      stdio: "ignore"
    });
    let exit: number | string | null = null;
    const exited = new Promise<number | string | null>((resolve) => {
      child.once("error", (error) => { resolve(exit = error.message); });
      child.once("exit", (code, signal) => { resolve(exit = code ?? signal); });
    });
    const run = this.run = { child, exited };
    void exited.then(() => { if (this.run === run) this.run = null; });

    const deadline = performance.now() + 30_000;
    try {
      while (!this.stopped && performance.now() < deadline) {
        // Exit 4 means another daemon took the profile lock. It can finish
        // starting while Desktop waits for the same control endpoint.
        if (exit !== null && exit !== 4) throw new Error(`mdbase daemon run exited (${exit}). See \`mdbase logs\`.`);
        const response = await requestDaemon<{ readiness: Readiness }>(this.control, "ping", {}, 2_000)
          .catch((error: unknown) => {
            if (!daemonNotRunning(error)) throw error;
            return null;
          });
        if (response && !this.stopped) {
          const { readiness } = response;
          if (compatibleVersion(readiness) !== version) {
            throw new Error("The direct mdbase daemon reported an unexpected version or control protocol.");
          }
          // The session shows the unlock state and can recover when the user
          // unlocks the keychain, using the same daemon process.
          if (readiness.ready || readiness.safe_reason === "credential_store_unavailable") return;
          if (readiness.safe_reason === "stopping") {
            throw new Error(`The direct mdbase daemon is not ready (${readiness.safe_reason}). See \`mdbase logs\`.`);
          }
        }
        await delay(100);
      }
      throw new Error("The direct mdbase daemon did not become ready. See `mdbase logs`.");
    } catch (error) {
      if (this.run === run && !this.stopped) await this.terminate(run);
      throw error;
    }
  }

  stop(): Promise<void> | undefined {
    this.stopped = true;
    if (this.run) return this.terminate(this.run);
  }

  private async terminate({ child, exited }: NonNullable<DirectDaemon["run"]>): Promise<void> {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 16_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
