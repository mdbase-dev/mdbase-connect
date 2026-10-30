/**
 * Local, monotonic background-work inhibition. This is denial bookkeeping, NOT
 * a currentness permit, destination-fence receipt or completed retirement.
 * A guarded importer must inhibit before copying state; absence preserves only
 * legacy behavior. There is deliberately no clear/resume operation.
 */
export const ALARM_INHIBITOR_KEY = "service-alarm-inhibited";

type AlarmStorage = Pick<DurableObjectStorage, "get" | "put" | "getAlarm" | "setAlarm" | "deleteAlarm">;

export class AlarmLifecycle {
  private inhibited = false;
  private scheduling: Promise<void> = Promise.resolve();
  constructor(private readonly storage: AlarmStorage) {}

  /** Synchronous local continuation fence; not a distributed generation. */
  get current(): boolean { return !this.inhibited; }

  /** Any present value, including malformed data, inhibits. Read failures throw
   * before callers can perform work; they never become an absence observation. */
  async allowed(): Promise<boolean> {
    if (this.inhibited) return false;
    try {
      // The one-key Map distinguishes an absent key from a stored undefined.
      if ((await this.storage.get<unknown>([ALARM_INHIBITOR_KEY])).has(ALARM_INHIBITOR_KEY)) this.inhibited = true;
    } catch {
      this.inhibited = true;
      throw new Error("alarm lifecycle unavailable");
    }
    return !this.inhibited;
  }

  /** Fence pending local continuations BEFORE the first await. Persist denial
   * BEFORE cancellation, preserving an existing marker verbatim. Cancellation
   * failure leaves durable denial for restart/reconciliation. A successful return
   * says nothing about an already-running handler, native drain or key erasure. */
  async inhibit(): Promise<void> {
    this.inhibited = true;
    if (!(await this.storage.get<unknown>([ALARM_INHIBITOR_KEY])).has(ALARM_INHIBITOR_KEY)) {
      await this.storage.put(ALARM_INHIBITOR_KEY, true);
    }
    await this.storage.deleteAlarm();
  }

  /** Keep earlier deadlines, except an exact provisional retry installed by
   * this opener. Return the deadline actually installed, or null when coalesced
   * or fenced. This is scheduling bookkeeping, never an authorization callback.
   * Serialize read/modify/write so an interleaved earlier wake cannot be lost. */
  schedule(at: number, current: () => boolean, replace?: number): Promise<number | null> {
    const operation = this.scheduling.then(async () => {
      if (!Number.isSafeInteger(at) || at <= 0) throw new Error("invalid alarm deadline");
      if (!current() || !await this.allowed() || !current() || !this.current) return null;
      const scheduled = await this.storage.getAlarm();
      if (!current() || !this.current) return null;
      const target = Math.max(Date.now() + 100, at);
      if (scheduled !== null && scheduled !== replace && scheduled <= target) return null;
      if (scheduled === target) return null;
      await this.storage.setAlarm(target);
      return target;
    });
    // Only the queue tail absorbs rejection; the caller still observes failure.
    this.scheduling = operation.then(() => {}, () => {});
    return operation;
  }
}
