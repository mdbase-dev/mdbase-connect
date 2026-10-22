/**
 * The write ledger: every local write that is not yet confirmed, and every write
 * the log refused, kept until the app acknowledges it. Entries are persisted
 * before the write is submitted (in the replica's own store for web apps), so a
 * reload still knows which records have unsaved or refused changes.
 *
 * Settlement is event-driven: receipts, and the replica's status push when its
 * pending count falls. Nothing here polls.
 */
import { isMdbaseError } from "./errors.js";
import type { PendingMutation, Problem, Receipt, Uuid } from "./wire.js";

export interface WriteLedgerEntry {
  readonly mutationId: Uuid;
  /** Records (or files) the write touches. */
  readonly records: readonly Uuid[];
  readonly createdAt: number;
  readonly state: "pending" | "rejected";
  /** Why the log refused it (rejected only). */
  readonly problem?: Problem;
}

/** Where entries persist. The default keeps them in memory only. */
export interface WriteLedgerStore {
  list(): Promise<readonly WriteLedgerEntry[]>;
  put(entry: WriteLedgerEntry): Promise<void>;
  remove(mutationId: Uuid): Promise<void>;
}

/**
 * - `saved`: nothing is waiting.
 * - `saving`: writes are on their way to the sync service.
 * - `saved_on_device`: writes are kept on this device and sync when it can reach
 *   the service (offline, or the service is unreachable or busy).
 * - `rejected`: the service refused a write; see `rejected` and `acknowledge`.
 */
export type SaveState = "saved" | "saving" | "saved_on_device" | "rejected";

export interface WriteLedgerSnapshot {
  readonly pending: readonly WriteLedgerEntry[];
  readonly rejected: readonly WriteLedgerEntry[];
  readonly saveState: SaveState;
  /** False until the entries from before this session have been reconciled. */
  readonly restored: boolean;
}

/** `client.ledger`. */
export interface WriteLedgerView {
  getSnapshot(): WriteLedgerSnapshot;
  subscribe(fn: () => void): () => void;
  /** The save state of one record. */
  stateOf(recordId: Uuid): SaveState;
  /** Forget a refused write after the app has shown it. */
  acknowledge(mutationId: Uuid): Promise<void>;
}

export function memoryWriteLedgerStore(): WriteLedgerStore {
  const rows = new Map<Uuid, WriteLedgerEntry>();
  return {
    list: async () => [...rows.values()],
    put: async (e) => void rows.set(e.mutationId, e),
    remove: async (id) => void rows.delete(id),
  };
}

const targets = (ops: readonly object[]): Uuid[] => [...new Set(ops.flatMap((op) => {
  const o = op as { id?: unknown; record?: unknown }, id = o.id ?? o.record;
  return typeof id === "string" ? [id] : [];
}))];
const entry = (mutationId: Uuid, records: readonly Uuid[], state: WriteLedgerEntry["state"], problem?: Problem, createdAt = Date.now()): WriteLedgerEntry =>
  problem ? { mutationId, records, createdAt, state, problem } : { mutationId, records, createdAt, state };

/** @internal Driven by MdbaseClient; apps read it as `client.ledger`. */
export class WriteLedger implements WriteLedgerView {
  private entries = new Map<Uuid, WriteLedgerEntry>();
  private listeners = new Set<() => void>();
  private snapshot: WriteLedgerSnapshot | null = null;
  private io: Promise<unknown> = Promise.resolve();
  private deferred = false;
  private restored = false;
  private checking = false;

  constructor(
    private readonly store: WriteLedgerStore,
    private readonly native: { receipt(id: Uuid): Promise<Receipt>; pendingWrites(): Promise<PendingMutation[]> },
  ) {}

  getSnapshot = (): WriteLedgerSnapshot => {
    const all = [...this.entries.values()];
    return this.snapshot ??= {
      pending: all.filter((e) => e.state === "pending"),
      rejected: all.filter((e) => e.state === "rejected"),
      saveState: this.stateOf(),
      restored: this.restored,
    };
  };

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  stateOf(recordId?: Uuid): SaveState {
    let pending = false;
    for (const e of this.entries.values()) {
      if (recordId !== undefined && !e.records.includes(recordId)) continue;
      if (e.state === "rejected") return "rejected";
      pending = true;
    }
    return !pending ? "saved" : this.deferred ? "saved_on_device" : "saving";
  }

  async acknowledge(mutationId: Uuid): Promise<void> {
    if (this.entries.get(mutationId)?.state === "rejected") await this.drop(mutationId);
  }

  get pendingCount(): number {
    return this.getSnapshot().pending.length;
  }

  /** @internal Whether pending writes are held back (offline, unreachable, busy). */
  setDeferred(deferred: boolean): void {
    if (deferred !== this.deferred) { this.deferred = deferred; this.changed(); }
  }

  /** @internal Persist intent BEFORE the write is submitted. */
  begin(mutationIds: readonly Uuid[], ops: readonly object[]): Promise<unknown> {
    return Promise.all(mutationIds.map((id, i) => this.set(entry(id, targets(mutationIds.length === 1 ? ops : [ops[i]!]), "pending"))));
  }

  /** @internal Apply a receipt from any source. */
  observe(r: Receipt): void {
    const e = this.entries.get(r.mutation), records = e?.records ?? (r.records ?? []).map((v) => v.id);
    if (r.state === "confirmed") { if (e) void this.drop(r.mutation); }
    else if (r.state === "pending") { if (!e) void this.set(entry(r.mutation, records, "pending")); }
    else if (e?.state !== "rejected")
      void this.set(entry(r.mutation, records, "rejected", r.problem ?? (r.state === "unknown"
        ? { code: "outcome_unknown", recovery: "resolve_outcome", message: "mutation unknown" }
        : { code: "internal", recovery: "contact_support", message: "mutation rejected" }), e?.createdAt));
  }

  /** @internal Reconcile persisted entries with the replica (on open). */
  async restore(): Promise<void> {
    try {
      const [stored, pending] = await Promise.all([
        this.store.list().catch(() => []),
        this.native.pendingWrites().catch(() => null),
      ]);
      for (const p of pending ?? [])
        if (!this.entries.has(p.receipt.mutation)) this.entries.set(p.receipt.mutation, entry(p.receipt.mutation, targets(p.ops), "pending"));
      for (const e of stored) if (e.state === "rejected" || !this.entries.has(e.mutationId)) this.entries.set(e.mutationId, e);
      this.changed();
      // Stored-pending entries the replica no longer lists settled while closed.
      const live = new Set(pending?.map((p) => p.receipt.mutation));
      if (pending) await Promise.all(stored.filter((e) => e.state === "pending" && !live.has(e.mutationId)).map((e) => this.settle(e.mutationId)));
    } finally {
      this.restored = true;
      this.changed();
    }
  }

  /** @internal The replica's pending count fell: settle what left pending. */
  async recheck(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try { for (const e of this.getSnapshot().pending) await this.settle(e.mutationId); }
    finally { this.checking = false; }
  }

  /** @internal The replica holds more pending writes than this ledger knows
   * (another tab of the same session wrote them): list them as pending too. */
  async adopt(): Promise<void> {
    const pending = await this.native.pendingWrites().catch(() => null);
    let added = false;
    for (const p of pending ?? [])
      if (!this.entries.has(p.receipt.mutation)) { this.entries.set(p.receipt.mutation, entry(p.receipt.mutation, targets(p.ops), "pending")); added = true; }
    if (added) this.changed();
  }

  /** @internal A submit call failed: ask the replica whether it captured these. */
  settleAll(ids: readonly Uuid[]): Promise<unknown> {
    return Promise.all(ids.map((id) => this.settle(id)));
  }

  private async settle(id: Uuid): Promise<void> {
    try { this.observe(await this.native.receipt(id)); }
    catch (error) {
      // The replica has no record of it: it never captured the write.
      if (isMdbaseError(error, "not_found") && this.entries.get(id)?.state === "pending") await this.drop(id);
    }
  }

  private set(e: WriteLedgerEntry): Promise<unknown> {
    this.entries.set(e.mutationId, e);
    this.changed();
    return this.persist(() => this.entries.get(e.mutationId) === e ? this.store.put(e) : undefined);
  }

  private drop(id: Uuid): Promise<unknown> {
    this.entries.delete(id);
    this.changed();
    return this.persist(() => this.entries.has(id) ? undefined : this.store.remove(id));
  }

  private persist(work: () => unknown): Promise<unknown> {
    return (this.io = this.io.then(work).catch(() => {}));
  }

  private changed(): void {
    this.snapshot = null;
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* an observer cannot break the ledger */ }
    }
  }
}
