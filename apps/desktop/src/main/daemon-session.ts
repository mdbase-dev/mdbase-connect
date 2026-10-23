import { t } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";
import { DaemonCli, type DaemonProfile } from "./daemon-cli";
import { CONTROL_PROTOCOL, DaemonConnection, daemonNotRunning, requestDaemon } from "./daemon-client";
import { ensureNextDaemon, nextDaemonRunner } from "./next-daemon";

/**
 * Keeping the app attached to the mdbase daemon.
 *
 * - Installed profile: the daemon is an OS service. The app makes sure the bundled
 *   version (or a newer self-installed one) is registered and running
 *   (`mdbase service status|install|start`, `next-daemon.ts`), never the old connector.
 * - Isolated profile (development, tests): `mdbase --state-dir … daemon start`; no service
 *   manager is touched.
 *
 * Then one long-lived connection subscribes to `status` pushes and reconnects with
 * backoff, so the UI and tray see changes without polling.
 */

export interface Readiness {
  schema_version: number;
  ready: boolean;
  binary_version: string;
  control_protocol: number;
  safe_reason?: string | null;
}

/** The parts of `DaemonStatus` the shell needs; the renderer receives the full object. */
export interface DaemonStatus {
  readiness: Readiness;
  account: { signed_in: boolean; online: boolean; pairing?: string | null; last_error?: string | null };
  collections: Array<{ id: string; name: string; state: string; reason?: string | null }>;
  [key: string]: unknown;
}

export type SessionState =
  | { phase: "starting" }
  | { phase: "ready"; status: DaemonStatus }
  | { phase: "not_ready"; status: DaemonStatus }
  | { phase: "disconnected"; error: string };

export interface SessionOptions {
  profile: DaemonProfile;
  /** The binary the app ships (installed profile) or runs (isolated profile). */
  bundled: { binary: string; version: string };
  cli: DaemonCli;
  /** Override for tests. */
  ensureInstalled?: () => Promise<unknown>;
  reconnectDelaysMs?: number[];
}

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];
const READY_WAIT_MS = 30_000;

/** Short tray/health text for a session state. */
export function healthLabel(state: SessionState): string {
  switch (state.phase) {
    case "starting":
      return t(i18n)({ message: "mdbase starting", context: "Desktop application" });
    case "ready":
      return state.status.account.signed_in ? t(i18n)({ message: "mdbase ready", context: "Desktop application" }) : t(i18n)({ message: "mdbase ready (not signed in)", context: "Desktop application" });
    case "not_ready":
      return state.status.readiness.safe_reason === "credential_store_unavailable"
        ? t(i18n)({ message: "Unlock your keychain to start mdbase", context: "Desktop application" })
        : t(i18n)({ message: "mdbase needs attention", context: "Desktop application" });
    case "disconnected":
      return t(i18n)({ message: "mdbase is not running", context: "Desktop application" });
  }
}

export class DaemonSession {
  private connection: DaemonConnection | null = null;
  private state: SessionState = { phase: "starting" };
  private readonly listeners = new Set<(state: SessionState) => void>();
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SessionOptions) {}

  get current(): SessionState {
    return this.state;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Make sure the daemon runs, then attach. Resolves once ready (or rejects). */
  async start(): Promise<void> {
    await this.ensureRunning();
    await this.attach();
  }

  /** Unprivileged request on the session's connection (or a fresh one). */
  async request<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (this.connection && !this.connection.isClosed) return this.connection.request<T>(method, params, timeoutMs);
    return requestDaemon<T>(this.options.profile.control, method, params, timeoutMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.connection?.close();
    this.connection = null;
  }

  private async ensureRunning(): Promise<void> {
    const { profile, bundled } = this.options;
    if (profile.target === "installed_service") {
      await (this.options.ensureInstalled ?? (() => ensureNextDaemon(nextDaemonRunner(bundled.binary), bundled.version)))();
      return;
    }
    try {
      const { readiness } = await requestDaemon<{ readiness: Readiness }>(profile.control, "ping", {}, 2_000);
      if (readiness?.control_protocol === CONTROL_PROTOCOL) return;
    } catch (error) {
      if (!daemonNotRunning(error)) throw error;
    }
    // `daemon start` waits until ready and exits 3 when it is not.
    await this.options.cli.run(["daemon", "start"], READY_WAIT_MS + 5_000);
  }

  private async attach(): Promise<void> {
    const connection = await DaemonConnection.connect(this.options.profile.control);
    this.connection = connection;
    connection.onPush((type, payload) => {
      if (type === "status") this.publish(payload as DaemonStatus);
    });
    connection.onClose(() => {
      if (this.connection === connection) this.connection = null;
      if (!this.stopped) this.scheduleReconnect("The connection to mdbase closed.");
    });
    // `status.subscribe` answers with the current status and pushes every change.
    this.publish(await connection.request<DaemonStatus>("status.subscribe"));
    this.attempt = 0;
  }

  private scheduleReconnect(error: string): void {
    this.setState({ phase: "disconnected", error });
    const delays = this.options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      // A stopped isolated daemon is restarted; an installed service is restarted by
      // its manager (and `ensureRunning` repairs a missing registration).
      this.ensureRunning()
        .then(() => this.attach())
        .catch((reason) => {
          if (!this.stopped) this.scheduleReconnect(reason instanceof Error ? reason.message : String(reason));
        });
    }, delay);
    this.timer.unref?.();
  }

  private publish(status: DaemonStatus): void {
    if (!status || typeof status !== "object" || !status.readiness) return;
    this.setState(status.readiness.ready ? { phase: "ready", status } : { phase: "not_ready", status });
  }

  private setState(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
