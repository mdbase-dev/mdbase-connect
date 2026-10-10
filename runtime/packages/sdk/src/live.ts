/**
 * Live query state (`replica-client-api.md` §4): the first push is a `snapshot`, then
 * `diff`s; `reset` means "a new snapshot follows". Because updates describe state,
 * applying them in order always gives the replica's current result.
 */
import type { QueryMetadata, QueryUpdate, RecordView, Uuid } from "./wire.js";

export interface LiveQueryState {
  /** The current result, in result order. */
  readonly records: readonly RecordView[];
  /** False while the replica installs a snapshot (rows may be missing). */
  readonly complete: boolean;
  /** Local view version of this result. */
  readonly asOf: number;
  /** Current full metadata at asOf; absent while stale or when not supplied. */
  readonly metadata?: QueryMetadata;
  /**
   * True until the first snapshot, and between a `reset` (or a reconnect) and the
   * next snapshot. The previous records stay visible meanwhile.
   */
  readonly stale: boolean;
}

export type LiveListener = (state: LiveQueryState, update: QueryUpdate | null) => void;

/** Applies `query-update` pushes to an ordered record set. */
export class LiveResult implements LiveQueryState {
  private byId = new Map<Uuid, RecordView>();
  private order: Uuid[] = [];
  private cached: RecordView[] | null = [];
  complete = false;
  asOf = 0;
  stale = true;
  metadata: QueryMetadata | undefined;

  get records(): readonly RecordView[] {
    return (this.cached ??= this.order.map((id) => this.byId.get(id)!).filter(Boolean));
  }

  get(id: Uuid): RecordView | undefined {
    return this.byId.get(id);
  }

  /** Mark stale (reconnect); records stay until the next snapshot replaces them. */
  markStale(): void {
    this.stale = true;
    this.metadata = undefined;
  }

  apply(u: QueryUpdate): void {
    switch (u.kind) {
      case "reset":
        this.stale = true;
        break;
      case "snapshot": {
        this.byId.clear();
        this.order = [];
        for (const r of u.added ?? []) {
          if (!this.byId.has(r.id)) this.order.push(r.id);
          this.byId.set(r.id, r);
        }
        if (u.order) this.reorder(u.order);
        this.stale = false;
        break;
      }
      case "diff": {
        if (u.removed?.length) {
          const gone = new Set(u.removed);
          for (const id of gone) this.byId.delete(id);
          this.order = this.order.filter((id) => !gone.has(id));
        }
        for (const r of u.changed ?? []) {
          if (!this.byId.has(r.id)) this.order.push(r.id);
          this.byId.set(r.id, r);
        }
        for (const r of u.added ?? []) {
          if (!this.byId.has(r.id)) this.order.push(r.id);
          this.byId.set(r.id, r);
        }
        if (u.order) this.reorder(u.order);
        break;
      }
    }
    // Metadata is a full replacement at THIS update's asOf, never a delta.
    // Reset/reconnect or omission must not present an older count/group as current.
    this.metadata = u.kind === "reset" || this.stale ? undefined : u.metadata;
    this.complete = u.complete;
    this.asOf = u.asOf;
    this.cached = null;
  }

  private reorder(order: Uuid[]): void {
    // The full ordered list. IDs we don't hold are skipped; rows missing from it keep
    // their place at the end (they will be corrected by the next diff).
    const seen = new Set<Uuid>();
    const next: Uuid[] = [];
    for (const id of order) if (this.byId.has(id) && !seen.has(id)) (seen.add(id), next.push(id));
    for (const id of this.order) if (!seen.has(id)) next.push(id);
    this.order = next;
  }
}
