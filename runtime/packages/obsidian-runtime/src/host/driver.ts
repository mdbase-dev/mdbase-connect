/**
 * The host side of the store's async drive (`crates/store-file/src/host.rs`:
 * `HostOp`/`HostDone`; interface note `2026-10-04-file-async-drive-fence-durability`).
 *
 * The store, running in `runtime.wasm`, queues `HostOp`s. The host loop is:
 * 1. drain `take_requests()`;
 * 2. perform each request here;
 * 3. `complete(id, HostDone)`;
 * 4. poll the store again.
 *
 * Each request type goes to its implementation:
 * - `File` → {@link VaultPlatform.perform} (vault adapter, main thread);
 * - `Journal` → {@link DualJournal}. `Append` completes only when **both** the vault
 *   append file and IndexedDB `strict` have the batch (the acknowledgement durability
 *   rule);
 * - `Fence` → {@link ObsidianEditorFence} (`Unknown` when the private fields aren't
 *   pinned, so the store waits instead of writing blind).
 *
 * Requests may complete in any order. Journal ops are serialised by `DualJournal`
 * itself, so an append never interleaves with a compaction.
 */

import type { DualJournal } from "../journal/dual.js";
import { JournalError, type JournalEntry } from "../journal/types.js";
import type { EditorState, FenceOutcome, ObsidianEditorFence } from "../fence/editorFence.js";
import type { VaultPlatform } from "../vault/platform.js";
import { FsError, type FileOp, type FileOpResult } from "../vault/types.js";

/** `JournalOp`. */
export type JournalOp = { readonly op: "Append"; readonly batch: readonly JournalEntry[] } | { readonly op: "Load" } | { readonly op: "Compact"; readonly live: readonly JournalEntry[] };

/** `FenceOp` (paths are collection-relative). */
export type FenceOp = { readonly op: "State"; readonly path: string } | { readonly op: "Apply"; readonly path: string; readonly base: string; readonly new: string };

/** `HostOp`. */
export type HostOp = { readonly kind: "File"; readonly op: FileOp } | { readonly kind: "Journal"; readonly op: JournalOp } | { readonly kind: "Fence"; readonly op: FenceOp };

/** `JournalError` as a value. */
export type JournalErr = { readonly kind: "full" | "lost" | "other"; readonly message: string };

/** `HostDone`. */
export type HostDone =
  | { readonly kind: "File"; readonly result: FileOpResult }
  | { readonly kind: "JournalUnit"; readonly result: { ok: true } | { ok: false; error: JournalErr } }
  | { readonly kind: "JournalLoad"; readonly result: { ok: true; entries: JournalEntry[] } | { ok: false; error: JournalErr } }
  | { readonly kind: "FenceState"; readonly state: EditorState }
  | { readonly kind: "FenceApply"; readonly outcome: FenceOutcome };

function journalErr(e: unknown): JournalErr {
  if (e instanceof JournalError) return { kind: e.kind, message: e.message };
  return { kind: "other", message: String(e) };
}

/** Performs host operations for one collection. */
export class HostDriver {
  constructor(
    private readonly vault: VaultPlatform,
    private readonly journal: DualJournal,
    private readonly fence: ObsidianEditorFence | null,
    /** Collection-relative path → vault path, for the fence (which sees vault paths). */
    private readonly toVaultPath: (rel: string) => string = (p) => vault.vaultPath(p),
  ) {}

  /** Perform one operation. Never rejects: failures are `HostDone` values. */
  async perform(op: HostOp): Promise<HostDone> {
    switch (op.kind) {
      case "File":
        return { kind: "File", result: await this.vault.perform(op.op) };
      case "Journal":
        return this.journalOp(op.op);
      case "Fence":
        return this.fenceOp(op.op);
    }
  }

  private async journalOp(op: JournalOp): Promise<HostDone> {
    try {
      switch (op.op) {
        case "Load":
          return { kind: "JournalLoad", result: { ok: true, entries: await this.journal.load() } };
        case "Append":
          await this.journal.append(op.batch);
          return { kind: "JournalUnit", result: { ok: true } };
        case "Compact":
          await this.journal.compact(op.live);
          return { kind: "JournalUnit", result: { ok: true } };
      }
    } catch (e) {
      return op.op === "Load" ? { kind: "JournalLoad", result: { ok: false, error: journalErr(e) } } : { kind: "JournalUnit", result: { ok: false, error: journalErr(e) } };
    }
  }

  private async fenceOp(op: FenceOp): Promise<HostDone> {
    if (op.op === "State") {
      if (!this.fence) return { kind: "FenceState", state: { kind: "Closed" } };
      try {
        return { kind: "FenceState", state: this.fence.state(this.toVaultPath(op.path)) };
      } catch {
        return { kind: "FenceState", state: { kind: "Unknown" } };
      }
    }
    if (!this.fence) return { kind: "FenceApply", outcome: { kind: "NotOpen" } };
    try {
      return { kind: "FenceApply", outcome: await this.fence.apply(this.toVaultPath(op.path), op.base, op.new) };
    } catch {
      return { kind: "FenceApply", outcome: { kind: "Unavailable" } };
    }
  }
}

/** What the runtime (WASM ABI) offers the host loop. Requested of sdk/wasm. */
export interface QueuedCore {
  /** `HostQueue::take_requests`. */
  takeRequests(): [bigint, HostOp][];
  /** `HostQueue::complete`. */
  complete(id: bigint, done: HostDone): void;
  /** Poll the store and replica at `nowMs`; returns the next wake-up (ms since epoch) or `null`. */
  poll(nowMs: number): number | null;
}

/**
 * The host loop: drain, perform concurrently, complete, poll; re-run when an
 * operation completes or the next wake-up arrives. `stop()` ends it after in-flight
 * operations complete.
 */
export class HostLoop {
  private running = false;
  private scheduled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  private idle: (() => void) | null = null;

  constructor(
    private readonly core: QueuedCore,
    private readonly perform: (op: HostOp) => Promise<HostDone>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    this.running = true;
    this.kick();
  }

  /** Wake the loop (a vault event was pushed, a client frame arrived). */
  kick(): void {
    if (!this.running || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.turn();
    });
  }

  private turn(): void {
    if (!this.running) return;
    const wake = this.core.poll(this.now());
    for (const [id, op] of this.core.takeRequests()) {
      this.inFlight++;
      void this.perform(op).then(
        (done) => this.finish(id, done),
        (e) => this.finish(id, failure(op, e)),
      );
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (wake !== null) this.timer = setTimeout(() => this.kick(), Math.max(0, wake - this.now()));
  }

  private finish(id: bigint, done: HostDone): void {
    this.inFlight--;
    this.core.complete(id, done);
    if (this.inFlight === 0) this.idle?.();
    this.kick();
  }

  /** Stop scheduling; resolves once in-flight operations have completed. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.inFlight > 0) await new Promise<void>((r) => (this.idle = r));
  }
}

function failure(op: HostOp, e: unknown): HostDone {
  const message = String(e);
  switch (op.kind) {
    case "File":
      return { kind: "File", result: { ok: false, error: new FsError("Other", message) } };
    case "Journal":
      return op.op.op === "Load" ? { kind: "JournalLoad", result: { ok: false, error: { kind: "other", message } } } : { kind: "JournalUnit", result: { ok: false, error: { kind: "other", message } } };
    case "Fence":
      return op.op.op === "State" ? { kind: "FenceState", state: { kind: "Unknown" } } : { kind: "FenceApply", outcome: { kind: "Unavailable" } };
  }
}
