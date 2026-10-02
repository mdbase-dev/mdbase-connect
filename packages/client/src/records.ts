import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { connectProblem } from "./errors.js";
import type {
  CollectionChange,
  ConnectRequestOptions,
  MdbaseWatchSubscription,
  PendingMutation,
  ReadInput,
  RecordDocument,
  UpdateInput
} from "./operation-types.js";
import {
  connectFailure,
  connectSuccess,
  type CollectionMutationProblemCode,
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
   * still saved; the session is dropped once no view holds it and it has
   * nothing left to save.
   */
  release(): void;
}

/** The parts of a connection a record session uses; `MdbaseConnection` satisfies it. */
interface RecordConnection<Frontmatter extends JsonObject> {
  read(input: ReadInput, options?: ConnectRequestOptions):
    Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionReadProblemCode>>;
  update(input: UpdateInput<Frontmatter>, options?: ConnectRequestOptions):
    Promise<ConnectOutcome<RecordDocument<Frontmatter>, CollectionMutationProblemCode>>;
  pendingMutation<Result>(requestId: string): PendingMutation<Result> | null;
}

interface Entry<Frontmatter extends JsonObject> {
  path: string;
  session: MdbaseRecordSession<RecordDocument<Frontmatter>>;
  leases: number;
  stopRetiring?: () => void;
}

interface Refresh<Frontmatter extends JsonObject> {
  entry: Entry<Frontmatter>;
  dirty: boolean;
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
  stopWaiting?: () => void;
}

// Match the coordinator's four foreground slots, never its 32-slot backlog.
const REFRESH_CONCURRENCY = 4;
const REFRESH_ATTEMPTS = 4;

type Opened<Frontmatter extends JsonObject> = ConnectOutcome<Entry<Frontmatter>, CollectionReadProblemCode>;

/**
 * Editable record sessions for one connection: `connection.records`. Every
 * view that opens the same path shares one session, so a record never has
 * two competing writers in one application.
 */
export class MdbaseRecords<Frontmatter extends JsonObject = JsonObject> {
  private readonly entries = new Map<string, Entry<Frontmatter>>();
  private readonly opening = new Map<string, Promise<Opened<Frontmatter>>>();
  private readonly refreshes = new Map<Entry<Frontmatter>, Refresh<Frontmatter>>();
  private readonly refreshQueue = new Set<Refresh<Frontmatter>>();
  private activeRefreshes = 0;
  private followers = 0;

  constructor(
    private readonly connection: RecordConnection<Frontmatter>,
    /** Finds this record's interrupted update, which survives reloads in durable storage. */
    private readonly pendingUpdate: (path: string) => Promise<string | null> = async () => null
  ) {}

  /**
   * Read a record and hold its editing session. Session options apply when
   * the session is first created; later opens share it as it is. A save
   * interrupted before a reload resumes as exact recovery.
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
   * Refreshes are bounded and coalesced per session, with three backed-off
   * retries for transient/not-sent reads. Failures remain in the snapshot.
   * Stopping the last follower drops queued work; admitted reads still settle.
   */
  follow(watch: Pick<MdbaseWatchSubscription, "subscribe">): () => void {
    this.followers += 1;
    const unsubscribe = watch.subscribe(
      (change) => this.apply(change),
      (status) => {
        // Changes were missed: every open record may be stale.
        if (status.state === "reset_required") {
          for (const entry of this.entries.values()) this.refresh(entry);
        }
      }
    );
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      if (--this.followers === 0) {
        for (const refresh of this.refreshes.values()) {
          clearTimeout(refresh.timer);
          refresh.stopWaiting?.();
        }
        this.refreshes.clear();
        this.refreshQueue.clear();
      }
    };
  }

  /** One invalidation owner per entry, including while it waits behind a write. */
  private refresh(entry: Entry<Frontmatter>): void {
    const existing = this.refreshes.get(entry);
    if (existing) {
      existing.dirty = true;
      return;
    }
    const refresh = { entry, dirty: false, attempts: 0 };
    this.refreshes.set(entry, refresh);
    this.enqueueRefresh(refresh);
  }

  /** Exact recovery must settle before refresh() can read the authoritative record. */
  private enqueueRefresh(refresh: Refresh<Frontmatter>): void {
    if (refresh.entry.session.snapshot.pendingRequestId) {
      refresh.stopWaiting = refresh.entry.session.subscribe(() => {
        if (refresh.entry.session.snapshot.pendingRequestId) return;
        refresh.stopWaiting?.();
        refresh.stopWaiting = undefined;
        this.enqueueRefresh(refresh);
      });
    } else {
      this.refreshQueue.add(refresh);
      this.pumpRefreshes();
    }
  }

  private pumpRefreshes(): void {
    while (this.activeRefreshes < REFRESH_CONCURRENCY && this.refreshQueue.size > 0) {
      const refresh = this.refreshQueue.values().next().value!;
      this.refreshQueue.delete(refresh);
      refresh.dirty = false;
      this.activeRefreshes += 1;
      void this.runRefresh(refresh);
    }
  }

  private async runRefresh(refresh: Refresh<Frontmatter>): Promise<void> {
    try {
      refresh.attempts += 1;
      const outcome = await refresh.entry.session.refresh();
      if (this.refreshes.get(refresh.entry) !== refresh) return;
      // A queued write may have entered recovery before refresh() could run.
      if (refresh.entry.session.snapshot.pendingRequestId) {
        refresh.attempts -= 1;
        this.enqueueRefresh(refresh);
        return;
      }
      // Cancellation is deliberate, not an availability failure. Never retry
      // authorization/input failures merely because they were not sent.
      const retry = !outcome.ok && outcome.problem.code !== "operation_cancelled"
        && (outcome.problem.recovery === "retry"
          || (outcome.problem.operation_outcome === "not_sent" && outcome.problem.category === "availability"));
      if (retry && refresh.attempts < REFRESH_ATTEMPTS) {
        refresh.timer = setTimeout(() => this.enqueueRefresh(refresh), 100 * 2 ** (refresh.attempts - 1));
      } else if (refresh.dirty) {
        // Any number of invalidations during a read needs just one follow-up.
        refresh.attempts = 0;
        this.enqueueRefresh(refresh);
      } else {
        this.refreshes.delete(refresh.entry);
      }
    } finally {
      this.activeRefreshes -= 1;
      this.pumpRefreshes();
    }
  }

  private async load(path: string, options: MdbaseRecordOpenOptions): Promise<Opened<Frontmatter>> {
    const { autosave, ...request } = options;
    const read = await this.connection.read({ path }, request);
    if (!read.ok) return read;
    const existing = this.entries.get(read.value.path);
    if (existing) return connectSuccess(existing);
    const entry = { path: read.value.path, leases: 0 } as Entry<Frontmatter>;
    entry.session = new MdbaseRecordSession(read.value, this.adapter(entry), { autosave });
    const interrupted = await this.pendingUpdate(entry.path);
    if (interrupted) entry.session.resumeRecovery(interrupted);
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
      const { state, dirty } = entry.session.snapshot;
      if (state !== "saved" && state !== "deleted" && !(state === "error" && !dirty)) return false;
      entry.stopRetiring?.();
      entry.stopRetiring = undefined;
      if (this.entries.get(entry.path) === entry) this.entries.delete(entry.path);
      const refresh = this.refreshes.get(entry);
      if (refresh) {
        clearTimeout(refresh.timer);
        refresh.stopWaiting?.();
        this.refreshQueue.delete(refresh);
        this.refreshes.delete(entry);
      }
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
      this.refresh(entry);
      return;
    }
    if (change.type !== "mdbase.record.modified" && change.type !== "mdbase.record.deleted") return;
    const entry = typeof payload.path === "string" ? this.entries.get(payload.path) : undefined;
    // The echo of this session's own acknowledged write needs no read.
    if (!entry || payload.revision === entry.session.snapshot.record.revision) return;
    this.refresh(entry);
  }
}
