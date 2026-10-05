// Background recovery is deliberately not run by account overview reads.
// Each pass discovers at most 25 transfers; the lifecycle function bounds SQL
// waits/provider RPCs and stops starting work after its 15-second pass budget.
export class AuthorityTransferRecoveryWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly recover: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly pollIntervalMs = 30_000
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.drainOnce().catch(this.onError);
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  drainOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) this.running = this.recover().finally(() => { this.running = undefined; });
    return this.running;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }
}
