/** Internal closed-cut mechanics, NOT operator authorization or actor admission.
 * Call sites must authenticate exact step GO/ledger and track EVERY continuation.
 * No endpoint is installed here. Restored RAM/SQL cannot authorize serving.
 */
import { parsePitrBinding, readPitrPhase, type PitrBinding, type PitrMember } from "./pitr-phase.ts";
const DEADLINE_MS = 30_000;
const CAPACITY = 64;
const closed = (): never => { throw new Error("pitr_cut_unknown"); };
const bookmarkValid = (s: unknown): s is string => typeof s === "string" && /^[!-~]{1,512}$/.test(s);
const memberKey = (m: PitrMember) => `${m.kind}/${m.collection}/${m.namespace}/${m.object}`;

/** RAM restriction only. close() fences before await and aborts owned I/O;
 * active work is removed ONLY by its actual finally, never by cancellation. */
export class PitrWork {
  private closed = false;
  private active = new Set<AbortController>();
  private idle: (() => void) | undefined;
  constructor(private readonly retain: (promise: Promise<void>) => void = () => {}) {}
  get drained(): boolean { return this.closed && this.active.size === 0; }
  begin(): { signal: AbortSignal; check(): void; finish(): void } { return this.ticket(false); }
  /** A CLOSED restriction callback still has a real lifetime. This cannot
   * reopen serving: its check requires the work to remain CLOSED. */
  beginClosed(): { signal: AbortSignal; check(): void; finish(): void } { return this.ticket(true); }
  /** Includes late get/read/cancel continuations after a bounded caller returns.
   * Tracking returns the original result, not an effect/admission permission. */
  trackClosed<T>(fn: () => Promise<T>): Promise<T> {
    const ticket = this.beginClosed();
    const pending = (async () => { try { return await fn(); } finally { ticket.finish(); } })();
    this.retain(pending.then(() => {}, () => {})); // Active actor lifetime; errors still reach the caller.
    return pending;
  }
  private ticket(requireClosed: boolean): { signal: AbortSignal; check(): void; finish(): void } {
    if (this.closed !== requireClosed || this.active.size >= CAPACITY) return closed();
    const abort = new AbortController();
    this.active.add(abort);
    let finished = false;
    return {
      signal: abort.signal,
      check: () => { if (this.closed !== requireClosed || finished || abort.signal.aborted) closed(); },
      finish: () => {
        if (finished) return;
        finished = true; this.active.delete(abort);
        if (this.drained) { this.idle?.(); this.idle = undefined; }
      },
    };
  }
  close(): void {
    this.closed = true;
    for (const abort of this.active) abort.abort();
  }
  async drain(): Promise<void> {
    if (!this.closed || this.idle) return closed();
    if (!this.active.size) return;
    await new Promise<void>(resolve => { this.idle = resolve; });
  }
}
export interface PitrCutReceipt {
  schema: "mdbn-lab-pitr-cut/1";
  run: PitrBinding["run"];
  codeConfigSha256: string;
  member: PitrMember;
  epoch: number;
  bookmark: string;
}
type CutState = Pick<DurableObjectState, "id" | "abort"> & {
  storage: Pick<DurableObjectStorage, "deleteAlarm" | "sync" | "getCurrentBookmark" | "onNextSessionRestoreBookmark">;
};
type GetPhase = Parameters<typeof readPitrPhase>[0];
type Step = <R>(fn: () => Promise<R>, track?: boolean) => Promise<R>;

export class PitrCut {
  private readonly binding: PitrBinding;
  private readonly member: PitrMember;
  private readonly minimumEpoch: number;
  private status: "idle" | "busy" | "unknown" = "idle";
  private pending: PitrCutReceipt | undefined;
  constructor(private readonly state: CutState, config: {
    binding: PitrBinding; member: PitrMember; minimumEpoch: number;
  }, private readonly get: GetPhase, private readonly work: PitrWork,
    private readonly stopResources: () => void, private readonly clock: () => number = Date.now,
    private readonly assertPhysical: () => void = () => {}) {
    const binding = parsePitrBinding(JSON.stringify(config.binding));
    if (!binding || !Number.isSafeInteger(config.minimumEpoch) || config.minimumEpoch < 1
        || !config.member || Object.keys(config.member).length !== 4
        || !binding.members.some(m => memberKey(m) === memberKey(config.member))
        || state.id.toString() !== config.member.object) throw new Error("pitr_cut_unknown");
    this.binding = binding;
    this.member = Object.freeze({ ...config.member });
    this.minimumEpoch = config.minimumEpoch;
    this.assertPhysical();
  }
  /** Prevent new actor restriction callbacks from crossing a cut/drain or an
   * unresolved restore. Existing late cleanup remains tracked until it settles. */
  assertRestrictionIdle(): void {
    if (this.status !== "idle" || this.pending) closed();
  }
  private receipt(epoch: number, bookmark: string): PitrCutReceipt {
    return { schema: "mdbn-lab-pitr-cut/1", run: this.binding.run, codeConfigSha256: this.binding.codeConfigSha256,
      member: { ...this.member }, epoch, bookmark };
  }
  private valid(r: PitrCutReceipt): boolean {
    return !!r && typeof r === "object" && Object.keys(r).length === 6
      && r.schema === "mdbn-lab-pitr-cut/1" && r.run === this.binding.run && r.codeConfigSha256 === this.binding.codeConfigSha256
      && !!r.member && typeof r.member === "object" && Object.keys(r.member).length === 4 && memberKey(r.member) === memberKey(this.member)
      && Number.isSafeInteger(r.epoch) && r.epoch >= this.minimumEpoch && bookmarkValid(r.bookmark);
  }
  /** RAM is sticky UNKNOWN; N1 must preserve UNKNOWN across resets externally. */
  private async operation<T>(body: (step: Step, verify: () => Promise<number>) => Promise<T>): Promise<T> {
    if (this.status !== "idle") return closed();
    this.status = "busy";
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let epoch: number | undefined;
    let lifetime: { issuedAt: number; expiresAt: number } | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { live = false; reject(new Error("pitr_cut_unknown")); }, DEADLINE_MS);
    });
    const step: Step = async <R>(fn: () => Promise<R>, track = true): Promise<R> => {
      if (!live) return closed();
      this.assertPhysical();
      const r = await Promise.race([track ? this.work.trackClosed(fn) : fn(), deadline]);
      this.assertPhysical();
      if (!live) return closed();
      return r;
    };
    const verify = async () => {
      if (this.state.id.toString() !== this.member.object) return closed();
      const phase = await step(() => readPitrPhase(this.get, this.binding, this.clock, () => this.minimumEpoch, fn => this.work.trackClosed(fn)));
      if (!phase || phase.phase !== "closed" || (epoch !== undefined && phase.epoch !== epoch)
          || (lifetime && (phase.issuedAt !== lifetime.issuedAt || phase.expiresAt !== lifetime.expiresAt))) return closed();
      epoch = phase.epoch;
      lifetime = { issuedAt: phase.issuedAt, expiresAt: phase.expiresAt };
      return epoch;
    };
    // Fence locally before any I/O, even if the external record proves UNKNOWN.
    try {
      this.work.close();
      this.stopResources(); // synchronous socket/subscription/timer/engine closure supplied by actor.
      const result = await Promise.race([body(step, verify), deadline]);
      if (!live || !this.work.drained) return closed();
      this.status = "idle";
      return result;
    } catch {
      this.status = "unknown";
      return closed();
    } finally { live = false; clearTimeout(timer!); }
  }
  private async quiesce(step: Step, verify: () => Promise<number>): Promise<number> {
    const epoch = await verify();
    await step(() => this.state.storage.deleteAlarm()); // does NOT cancel an executing alarm.
    await step(() => this.work.drain(), false); // Do not count the drain waiter as work it waits for.
    await step(() => this.state.storage.sync());
    await verify();
    if (!this.work.drained) return closed();
    return epoch;
  }
  async capture(): Promise<PitrCutReceipt> {
    if (this.pending) return closed();
    return this.operation(async (step, verify) => {
      const epoch = await this.quiesce(step, verify);
      const bookmark = await step(() => this.state.storage.getCurrentBookmark());
      await verify();
      if (!bookmarkValid(bookmark)) return closed();
      return this.receipt(epoch, bookmark);
    });
  }
  /** Arms next-session restore; returns FUTURE undo anchor, not restore/restart ACK.
   * Unknown outcome can have armed storage already. Never retry it automatically. */
  async stageRestore(original: PitrCutReceipt): Promise<PitrCutReceipt> {
    if (this.pending || !this.valid(original)) return closed();
    const snapshot = this.receipt(original.epoch, original.bookmark);
    return this.operation(async (step, verify) => {
      const epoch = await this.quiesce(step, verify);
      if (epoch < snapshot.epoch || !this.valid(original) || original.bookmark !== snapshot.bookmark || original.epoch !== snapshot.epoch) return closed();
      const undo = await step(() => this.state.storage.onNextSessionRestoreBookmark(snapshot.bookmark));
      await verify();
      if (!bookmarkValid(undo)) return closed();
      const receipt = this.receipt(epoch, undo);
      this.pending = this.receipt(epoch, undo); // detached from response mutation.
      return receipt;
    });
  }
  /** Separate call so the operator can ledger the undo anchor BEFORE reset.
   * Omit undo only for a closed, non-restore restart. No success ACK after abort. */
  async restart(undo?: PitrCutReceipt): Promise<never> {
    if (Boolean(undo) !== Boolean(this.pending) || (undo && (!this.valid(undo) || !this.pending
        || undo.bookmark !== this.pending.bookmark || undo.epoch !== this.pending.epoch))) return closed();
    return this.operation(async (step, verify) => {
      const epoch = await this.quiesce(step, verify);
      if (this.pending && epoch !== this.pending.epoch) return closed();
      await verify();
      this.state.abort("LAB PITR closed restart", { retryAlarm: false });
      // Actual abort resets without a catchable return; fake/runtime mismatch cannot ACK.
      return closed();
    });
  }
}
