/** Isolate-local, single active attachment stream; one bounded waiting call.
 * A stream holds its slot through network/decrypt/ACK backpressure. No ciphertext
 * body is fetched for queued calls. This is a resource limit, never authority.
 */
export class ChunkBusy extends Error {
  readonly reason = "hosted_chunk_busy";
  readonly retryAfterMs = 1000;
  constructor() { super("hosted attachment reader is busy"); }
}
export interface ChunkPermit {
  readonly active: boolean;
  touch(): void;
  release(): void;
}
type Waiter = { resolve: (p: ChunkPermit) => void; reject: (e: ChunkBusy) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort: () => void };
export class ChunkSlots {
  private held: ChunkPermit | null = null;
  private queue: Waiter[] = [];
  constructor(private readonly maxQueued = 1, private readonly waitMs = 15_000, private readonly idleMs = 60_000) {}
  acquire(signal?: AbortSignal): Promise<ChunkPermit> {
    // Expiry is checked even when the platform didn't run an idle timer.
    void this.held?.active;
    if (signal?.aborted) return Promise.reject(new ChunkBusy());
    if (!this.held) return Promise.resolve(this.grant());
    if (this.queue.length >= this.maxQueued) return Promise.reject(new ChunkBusy());
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) { this.queue.splice(index, 1); this.clean(waiter); reject(new ChunkBusy()); }
      };
      const waiter: Waiter = { resolve, reject, timer: setTimeout(abort, this.waitMs), signal, abort };
      this.queue.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private clean(w: Waiter): void { clearTimeout(w.timer); w.signal?.removeEventListener("abort", w.abort); }
  private grant(): ChunkPermit {
    let released = false, deadline = Date.now() + this.idleMs;
    let timer: ReturnType<typeof setTimeout>;
    const release = () => {
      if (released) return;
      released = true; clearTimeout(timer);
      if (this.held !== permit) return;
      this.held = null;
      const next = this.queue.shift();
      if (next) { this.clean(next); next.resolve(this.grant()); }
    };
    const permit: ChunkPermit = {
      get active() { if (!released && Date.now() >= deadline) release(); return !released; },
      touch: () => {
        if (!permit.active) return;
        deadline = Date.now() + this.idleMs;
        clearTimeout(timer); timer = setTimeout(release, this.idleMs);
      },
      release,
    };
    timer = setTimeout(release, this.idleMs);
    this.held = permit;
    return permit;
  }
}
/** Shared across collection DO instances in this Worker isolate. */
export const attachmentSlots = new ChunkSlots();
