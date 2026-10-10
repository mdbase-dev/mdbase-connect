/** Bounded host read primitive; NOT an attachment wire/crypto or path-resolver API. */
export const ATTACHMENT_RANGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;

export interface RangeSnapshot {
  readonly kind: "file" | "other";
  readonly identity: string;
  readonly version: string;
  readonly size: number;
}

/**
 * The provider owns a previously opened, root-confined stable handle. snapshot
 * and readInto MUST use that handle, never reopen a pathname. Mobile/desktop
 * path confinement and publication durability require separate qualification.
 */
export interface RangeBackend {
  snapshot(): Promise<RangeSnapshot>;
  /** May return a short read; never allocate a whole-file buffer. */
  readInto(offset: number, target: Uint8Array): Promise<number>;
  close(): Promise<void>;
}

export class AttachmentRangeError extends Error {
  constructor(readonly code: "invalid_range" | "full" | "busy" | "closed" | "source_changed" | "unsupported" | "io") {
    super(`attachment range: ${code}`);
    this.name = "AttachmentRangeError";
  }
}

/** Failed-open cleanup still owns the backend; caller must retry instead of forgetting it. */
export class AttachmentRangeOpenError extends AttachmentRangeError {
  #cleanup: () => Promise<void>;
  constructor(code: AttachmentRangeError["code"], cleanup: () => Promise<void>) {
    super(code);
    this.#cleanup = cleanup;
  }
  retryCleanup(): Promise<void> { return this.#cleanup(); }
}

function disposeBytes(data: Uint8Array): void {
  data.fill(0);
  // Modern hosts can immediately detach/free the backing store rather than
  // retaining many retired chunks until GC. Older hosts still wipe; their peak
  // allocation budget needs independent qualification.
  const buffer = data.buffer as ArrayBuffer & { transfer?: (length: number) => ArrayBuffer };
  if (typeof buffer.transfer === "function") { try { buffer.transfer(0); } catch {} }
}

/** Borrowed plaintext: release wipes/detaches it. Only one lease per source is allowed. */
export class RangeLease {
  private released = false;
  constructor(private data: Uint8Array | null, private readonly done: () => void) {}
  get bytes(): Uint8Array {
    if (this.released || !this.data) throw new AttachmentRangeError("closed");
    return this.data;
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.data) disposeBytes(this.data);
    this.data = null;
    this.done();
  }
}

function validSnapshot(s: RangeSnapshot): void {
  if (s.kind !== "file") throw new AttachmentRangeError("unsupported");
  if (!s.identity || !s.version || !Number.isSafeInteger(s.size) || s.size < 0) throw new AttachmentRangeError("unsupported");
}
function same(a: RangeSnapshot, b: RangeSnapshot): boolean {
  return a.kind === b.kind && a.identity === b.identity && a.version === b.version && a.size === b.size;
}

/**
 * Pull-based, single-lease source. It bounds this primitive's owned plaintext to
 * one chunk; callers must also budget ciphertext, WASM, IPC and downstream copies.
 * No complete-file hash, encryption, root confinement or publication is claimed.
 */
export class BoundedRangeSource {
  private closed = false;
  private busy = false;
  private lease: RangeLease | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private constructor(private readonly backend: RangeBackend, readonly snapshot: RangeSnapshot) {}

  /** Takes ownership of backend, including on a failed open. */
  static async open(backend: RangeBackend, opts: { maxFileBytes?: number } = {}): Promise<BoundedRangeSource> {
    try {
      const limit = opts.maxFileBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
      if (!Number.isSafeInteger(limit) || limit < 0) throw new AttachmentRangeError("invalid_range");
      const snapshot = { ...await backend.snapshot() };
      validSnapshot(snapshot);
      if (snapshot.size > limit) throw new AttachmentRangeError("full");
      return new BoundedRangeSource(backend, Object.freeze(snapshot));
    } catch (e) {
      const code = e instanceof AttachmentRangeError ? e.code : "io";
      try { await backend.close(); }
      catch { throw new AttachmentRangeOpenError(code, () => backend.close()); }
      throw new AttachmentRangeError(code);
    }
  }

  async readAt(offset: number, length: number, signal?: AbortSignal): Promise<RangeLease> {
    if (this.closed) throw new AttachmentRangeError("closed");
    if (this.busy || this.lease) throw new AttachmentRangeError("busy");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.snapshot.size || !Number.isSafeInteger(length) || length < 0)
      throw new AttachmentRangeError("invalid_range");
    if (length > ATTACHMENT_RANGE_BYTES) throw new AttachmentRangeError("full");
    this.busy = true;
    let finish!: () => void;
    this.inFlight = new Promise<void>(resolve => { finish = resolve; });
    let data: Uint8Array | null = null;
    let handed = false;
    const abort = () => { void this.close().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    const live = () => {
      if (this.closed || signal?.aborted) throw new AttachmentRangeError("closed");
    };
    try {
      live();
      const before = await this.backend.snapshot();
      live();
      if (!same(this.snapshot, before)) throw new AttachmentRangeError("source_changed");
      data = new Uint8Array(Math.min(length, this.snapshot.size - offset));
      let filled = 0;
      while (filled < data.length) {
        live();
        const read = await this.backend.readInto(offset + filled, data.subarray(filled));
        live();
        if (!Number.isSafeInteger(read) || read < 1 || read > data.length - filled) throw new AttachmentRangeError("source_changed");
        filled += read;
      }
      const after = await this.backend.snapshot();
      live();
      if (!same(this.snapshot, after)) throw new AttachmentRangeError("source_changed");
      const lease = new RangeLease(data, () => { if (this.lease === lease) this.lease = null; });
      this.lease = lease;
      handed = true;
      return lease;
    } catch (e) {
      // Fail-stop. close waits for this operation, so do not await it here.
      void this.close().catch(() => {});
      throw e instanceof AttachmentRangeError ? e : new AttachmentRangeError("io");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!handed && data) disposeBytes(data);
      this.busy = false;
      finish();
    }
  }

  /** Invalidates immediately; waits for bounded outstanding IO before closing. */
  close(): Promise<void> {
    this.closed = true;
    this.lease?.release();
    if (!this.closing) {
      const closing = this.inFlight.then(() => this.backend.close());
      this.closing = closing;
      void closing.catch(() => { if (this.closing === closing) this.closing = null; });
    }
    return this.closing;
  }
}
