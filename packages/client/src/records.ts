import type { JsonObject } from "@mdbase-dev/connect-protocol";
import type { MdbaseConnection } from "./connection.js";
import { connectProblem } from "./errors.js";
import type {
  CollectionChange,
  ConnectRequestOptions,
  MdbaseWatchSubscription,
  RecordDocument
} from "./operation-types.js";
import {
  connectFailure,
  connectSuccess,
  type CollectionReadProblemCode,
  type ConnectOutcome
} from "./outcomes.js";
import {
  MdbaseRecordSession,
  type MdbaseRecordSessionAdapter,
  type MdbaseRecordSessionOptions
} from "./record-session.js";

export interface MdbaseRecordOpenOptions extends ConnectRequestOptions, MdbaseRecordSessionOptions {}

/** One view's hold on a shared record session. */
export interface MdbaseRecordLease<Frontmatter extends JsonObject = JsonObject> {
  readonly session: MdbaseRecordSession<RecordDocument<Frontmatter>>;
  /**
   * Stop using the session from this view. Idempotent. Local changes are
   * still saved; the session is dropped once no view holds it and it is saved.
   */
  release(): void;
}

type RecordConnection<Frontmatter extends JsonObject> =
  Pick<MdbaseConnection<Frontmatter>, "read" | "update" | "pendingMutation">;

interface Entry<Frontmatter extends JsonObject> {
  path: string;
  session: MdbaseRecordSession<RecordDocument<Frontmatter>>;
  leases: number;
  stopRetiring?: () => void;
}

type Opened<Frontmatter extends JsonObject> = ConnectOutcome<Entry<Frontmatter>, CollectionReadProblemCode>;

/**
 * Editable record sessions for one connection: `connection.records`. Every
 * view that opens the same path shares one session, so a record never has
 * two competing writers in one application.
 */
export class MdbaseRecords<Frontmatter extends JsonObject = JsonObject> {
  private readonly entries = new Map<string, Entry<Frontmatter>>();
  private readonly opening = new Map<string, Promise<Opened<Frontmatter>>>();

  constructor(private readonly connection: RecordConnection<Frontmatter>) {}

  /**
   * Read a record and hold its editing session. Session options apply when
   * the session is first created; later opens share it as it is.
   */
  async open(
    path: string,
    options: MdbaseRecordOpenOptions = {}
  ): Promise<ConnectOutcome<MdbaseRecordLease<Frontmatter>, CollectionReadProblemCode>> {
    for (;;) {
      const existing = this.entries.get(path);
      if (existing) return connectSuccess(this.lease(existing));
      const shared = this.opening.get(path);
      const opening = shared ?? this.load(path, options);
      if (!shared) {
        this.opening.set(path, opening);
        void opening.then(() => this.opening.delete(path));
      }
      const opened = await opening;
      if (opened.ok) return connectSuccess(this.lease(opened.value));
      // Another caller's cancellation or deadline does not end this one's open.
      const foreign = shared && (opened.problem.code === "operation_cancelled" || opened.problem.code === "timeout");
      if (!foreign || options.signal?.aborted) return opened;
    }
  }

  /**
   * Keep open sessions current from a collection watch: changed records are
   * refreshed, renamed records are followed and deleted records are marked.
   * Returns a function that stops following.
   */
  follow(watch: Pick<MdbaseWatchSubscription, "subscribe">): () => void {
    return watch.subscribe(
      (change) => this.apply(change),
      (status) => {
        // Changes were missed: every open record may be stale.
        if (status.state === "reset_required") {
          for (const entry of this.entries.values()) void entry.session.refresh();
        }
      }
    );
  }

  private async load(path: string, options: MdbaseRecordOpenOptions): Promise<Opened<Frontmatter>> {
    const { autosave, ...request } = options;
    const read = await this.connection.read({ path }, request);
    if (!read.ok) return read;
    const existing = this.entries.get(read.value.path);
    if (existing) return connectSuccess(existing);
    const entry = { path: read.value.path, leases: 0 } as Entry<Frontmatter>;
    entry.session = new MdbaseRecordSession(read.value, this.adapter(entry), { autosave });
    this.entries.set(entry.path, entry);
    return connectSuccess(entry);
  }

  /** Writes and reads follow the entry's current path, so a followed rename needs no new session. */
  private adapter(entry: Entry<Frontmatter>): MdbaseRecordSessionAdapter<RecordDocument<Frontmatter>> {
    return {
      revision: (record) => record.revision,
      body: (record) => record.body ?? "",
      frontmatter: (record) => record.frontmatter,
      write: (base, change, options) => this.connection.update({
        path: entry.path,
        ifRevision: base.revision,
        patch: (change.patch ?? {}) as Partial<Frontmatter> & JsonObject,
        ...(change.body === undefined ? {} : { body: change.body })
      }, options),
      read: (_base, options) => this.connection.read({ path: entry.path }, options),
      recover: async (requestId, options) => {
        const pending = this.connection.pendingMutation<RecordDocument<Frontmatter>>(requestId);
        return pending
          ? pending.recover(options)
          : connectFailure(connectProblem("no_pending_mutation", "The interrupted write is no longer pending."));
      },
      isPending: (requestId) => this.connection.pendingMutation(requestId) !== null
    };
  }

  private lease(entry: Entry<Frontmatter>): MdbaseRecordLease<Frontmatter> {
    entry.leases += 1;
    entry.stopRetiring?.();
    entry.stopRetiring = undefined;
    let released = false;
    return {
      session: entry.session,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        this.retire(entry);
      }
    };
  }

  /** Drop an unheld session once it has nothing left to save. */
  private retire(entry: Entry<Frontmatter>): void {
    if (entry.leases > 0) return;
    const drop = () => {
      const { state } = entry.session.snapshot;
      if (state !== "saved" && state !== "deleted") return false;
      entry.stopRetiring?.();
      entry.stopRetiring = undefined;
      if (this.entries.get(entry.path) === entry) this.entries.delete(entry.path);
      return true;
    };
    if (!drop()) entry.stopRetiring = entry.session.subscribe(() => void drop());
  }

  private apply(change: CollectionChange): void {
    const { payload } = change;
    if (change.type === "mdbase.record.renamed") {
      const entry = typeof payload.from === "string" ? this.entries.get(payload.from) : undefined;
      if (!entry || typeof payload.to !== "string") return;
      this.entries.delete(entry.path);
      entry.path = payload.to;
      this.entries.set(entry.path, entry);
      void entry.session.refresh();
      return;
    }
    if (change.type !== "mdbase.record.modified" && change.type !== "mdbase.record.deleted") return;
    const entry = typeof payload.path === "string" ? this.entries.get(payload.path) : undefined;
    // The echo of this session's own acknowledged write needs no read.
    if (!entry || payload.revision === entry.session.snapshot.record.revision) return;
    void entry.session.refresh();
  }
}
