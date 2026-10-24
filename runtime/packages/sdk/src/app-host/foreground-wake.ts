/** Host lifecycle hints -> existing authenticated native unary reconnect/head.
 * No remote push decoding, new auth/signing API, keyed/Saved or lease authority.
 * Optional/unexported. Host retains Worker/installation/collection ownership. */
import type { AppCpLogAuthority } from "./cp-authority.js";
import type { AppWasmRuntime } from "./wasm-runtime.js";

export class AppForegroundWakeError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "unavailable") { super(`app foreground wake: ${reason}`); this.name = "AppForegroundWakeError"; }
}
type Runtime = Pick<AppWasmRuntime, "reconnectLogTransport" | "tick">;
type Authority = Pick<AppCpLogAuthority, "accessToken" | "logTransport" | "isCurrent" | "endpoint" | "collection" | "origin">;
export class AppForegroundLogWake {
  private readonly pins: Readonly<{ endpoint: bigint; collection: string; origin: string }>;
  private readonly lifetime = new AbortController();
  private readonly period: number;
  private visible = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<boolean> | null = null;
  constructor(private readonly runtime: Runtime, private readonly authority: Authority,
    private readonly options: { periodMs?: number; onUnavailable?: () => void } = {}) {
    this.period = options.periodMs ?? 60_000;
    if (!Number.isSafeInteger(this.period) || this.period < 5_000 || this.period > 300_000 || !authority.isCurrent()) throw new AppForegroundWakeError("binding");
    this.pins = Object.freeze({ endpoint: authority.endpoint, collection: authority.collection, origin: authority.origin });
  }
  private check(): void {
    try { if (this.closed || this.lifetime.signal.aborted || !this.authority.isCurrent() || this.authority.endpoint !== this.pins.endpoint ||
      this.authority.collection !== this.pins.collection || this.authority.origin !== this.pins.origin) throw new AppForegroundWakeError("fenced"); }
    catch { throw new AppForegroundWakeError("fenced"); }
  }
  /** First-party host forwards visibility/Capacitor resume, never a remote
   * Reconnected push. CP access is admitted before native session replacement. */
  foreground(): Promise<boolean> { this.check(); this.visible = true; return this.request(); }
  hidden(): void { this.visible = false; this.clearTimer(); }
  /** CP notify is only a coalesced hint for THIS collection. Hidden hints need
   * no queue: next foreground/head learns the actual authenticated prefix. */
  notificationHint(collection: string): Promise<boolean> {
    this.check(); if (collection !== this.pins.collection || !this.visible) return Promise.resolve(false); return this.request();
  }
  private request(): Promise<boolean> {
    this.check(); if (!this.visible) return Promise.resolve(false);
    if (this.running) return this.running;
    this.clearTimer();
    const run = this.perform().finally(() => { this.running = null; this.schedule(); });
    this.running = run; return run;
  }
  private async perform(): Promise<boolean> {
    try {
      this.check(); await this.authority.accessToken({ signal: this.lifetime.signal }); this.check();
      if (!this.visible) return false;
      // Existing replacement aborts/drains old IO; retains SAME original native
      // owners/lease and classifies originals unknown. No fresh/reset fallback.
      const pump = await this.runtime.reconnectLogTransport(this.authority.logTransport()); this.check();
      if (!this.visible) return false;
      this.runtime.tick(); await pump.pump(); this.check(); return true;
    } catch (error) {
      if (error instanceof AppForegroundWakeError) throw error;
      this.check(); // Offline CP failure does NOT destroy verified local owners.
      throw new AppForegroundWakeError("unavailable");
    }
  }
  private clearTimer(): void { if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; } }
  private schedule(): void {
    if (!this.visible || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; void Promise.resolve().then(() => this.request()).catch(() => { try { this.options.onUnavailable?.(); } catch { /* content-free host notification only */ } }); }, this.period);
    (this.timer as { unref?: () => void }).unref?.();
  }
  /** Scheduler shutdown only: NOT native retirement or lease release. Hung
   * native IO requires host Worker termination BEFORE lease release. */
  async close(): Promise<void> {
    this.closed = true; this.visible = false; this.clearTimer(); this.lifetime.abort();
    try { await this.running; } catch { /* fenced or unavailable; no state reset */ }
  }
}
