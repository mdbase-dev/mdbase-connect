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

  /** Keep the earlier deadline without allowing an inhibited/stale continuation
   * to install a new alarm after a storage await. The caller's fence must be a
   * synchronous local identity check, not an authorization callback. */
  async schedule(at: number, current: () => boolean): Promise<void> {
    if (!Number.isSafeInteger(at) || at <= 0) throw new Error("invalid alarm deadline");
    if (!current() || !await this.allowed() || !current() || !this.current) return;
    const scheduled = await this.storage.getAlarm();
    if (!current() || !this.current) return;
    await this.storage.setAlarm(Math.max(Date.now() + 100, Math.min(at, scheduled ?? at)));
  }
}
