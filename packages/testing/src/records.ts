import {
  MdbaseRecords,
  type CollectionChange,
  type ConnectOutcome,
  type ConnectProblem,
  type JsonObject,
  type MdbaseWatchSubscription,
  type PendingMutation,
  type ReadInput,
  type RecordDocument,
  type UpdateInput,
  type WatchStatus
} from "@mdbase-dev/connect";
import { connectFailure, connectProblem, connectSuccess } from "@mdbase-dev/connect/advanced";

export interface MdbaseTestRecordInput<Frontmatter extends JsonObject = JsonObject> {
  body?: string;
  frontmatter?: Frontmatter;
}

/**
 * An in-memory collection authority for testing record editing: revision
 * checks, a change watch, and controls for what other clients and the
 * network do. `records` is the real `MdbaseRecords` over it.
 */
export interface MdbaseRecordTestAuthority<Frontmatter extends JsonObject = JsonObject> {
  readonly records: MdbaseRecords<Frontmatter>;
  /** Emits this authority's changes; pass it to `records.follow()`. */
  readonly watch: Pick<MdbaseWatchSubscription, "subscribe" | "close">;
  /** Writes that reached the authority, in order, including a lost-response write. */
  readonly writes: readonly UpdateInput<Frontmatter>[];
  seed(path: string, record?: MdbaseTestRecordInput<Frontmatter>): RecordDocument<Frontmatter>;
  get(path: string): RecordDocument<Frontmatter> | undefined;
  /** Another client edits the record; the watch reports it. */
  editElsewhere(path: string, change: { body?: string; patch?: Partial<Frontmatter> }): RecordDocument<Frontmatter>;
  renameElsewhere(from: string, to: string): RecordDocument<Frontmatter>;
  deleteElsewhere(path: string): void;
  /** Report a change gap to followers, as a watch does after missing events. */
  resetWatch(): void;
  /** The next update is applied, but its response is lost: the write's outcome is unknown until recovered. */
  loseNextResponse(): void;
  /** The next update is refused with this problem and not applied. */
  failNextWrite(problem: ConnectProblem): void;
}

export function createRecordTestAuthority<Frontmatter extends JsonObject = JsonObject>(): MdbaseRecordTestAuthority<Frontmatter> {
  const stored = new Map<string, RecordDocument<Frontmatter>>();
  const pending = new Map<string, PendingMutation<RecordDocument<Frontmatter>>>();
  const listeners = new Set<(change: CollectionChange) => void>();
  const statuses = new Set<(status: WatchStatus) => void>();
  const writes: UpdateInput<Frontmatter>[] = [];
  let revision = 0;
  let cursor = 0;
  let loseNext = false;
  let failNext: ConnectProblem | undefined;

  const copy = (record: RecordDocument<Frontmatter>) => structuredClone(record);
  const put = (path: string, body: string, frontmatter: Frontmatter): RecordDocument<Frontmatter> => {
    const record: RecordDocument<Frontmatter> = {
      path, revision: `rev-${String(++revision)}`, body, frontmatter,
      effectiveFrontmatter: frontmatter, types: [], file: { path }
    };
    stored.set(path, record);
    return record;
  };
  const emit = (type: string, payload: JsonObject) => {
    const change: CollectionChange = { cursor: ++cursor, type, occurredAt: new Date().toISOString(), payload };
    for (const listener of [...listeners]) listener(change);
  };
  const missing = (path: string) => connectFailure(connectProblem("file_not_found", `File not found: ${path}`));
  const required = (path: string) => {
    const record = stored.get(path);
    if (!record) throw new Error(`No record at ${path}; seed it first.`);
    return record;
  };

  const connection = {
    async read(input: ReadInput): Promise<ConnectOutcome<RecordDocument<Frontmatter>>> {
      const record = stored.get(input.path);
      return record ? connectSuccess(copy(record)) : missing(input.path);
    },
    async update(input: UpdateInput<Frontmatter>): Promise<ConnectOutcome<RecordDocument<Frontmatter>>> {
      if (failNext) {
        const problem = failNext;
        failNext = undefined;
        return connectFailure(problem);
      }
      const current = stored.get(input.path);
      if (!current) return missing(input.path);
      if (input.ifRevision !== undefined && input.ifRevision !== current.revision) {
        return connectFailure(connectProblem("concurrent_modification",
          `File '${input.path}' was modified externally`, { operationOutcome: "rejected" }));
      }
      writes.push(structuredClone(input));
      const next = put(input.path, "body" in input && input.body !== undefined ? input.body : current.body ?? "",
        { ...current.frontmatter, ...("patch" in input ? input.patch : {}) } as Frontmatter);
      emit("mdbase.record.modified", { path: next.path, revision: next.revision });
      if (!loseNext) return connectSuccess(copy(next));
      loseNext = false;
      const requestId = `lost-${String(revision)}`;
      pending.set(requestId, {
        requestId,
        operation: "update",
        fingerprint: requestId,
        status: "outcome_unknown",
        createdAt: new Date().toISOString(),
        recover: async () => {
          pending.delete(requestId);
          return connectSuccess(copy(next));
        }
      });
      return connectFailure(connectProblem("operation_outcome_unknown", "The response was lost", {
        operationOutcome: "unknown", details: { request_id: requestId }
      }));
    },
    pendingMutation<Result>(requestId: string): PendingMutation<Result> | null {
      return (pending.get(requestId) ?? null) as PendingMutation<Result> | null;
    }
  };

  return {
    records: new MdbaseRecords<Frontmatter>(connection as unknown as ConstructorParameters<typeof MdbaseRecords<Frontmatter>>[0]),
    watch: {
      subscribe(listener, onStatus) {
        listeners.add(listener);
        if (onStatus) statuses.add(onStatus);
        return () => {
          listeners.delete(listener);
          if (onStatus) statuses.delete(onStatus);
        };
      },
      close() {
        listeners.clear();
        statuses.clear();
      }
    },
    writes,
    seed: (path, record = {}) => copy(put(path, record.body ?? "", (record.frontmatter ?? {}) as Frontmatter)),
    get: (path) => {
      const record = stored.get(path);
      return record ? copy(record) : undefined;
    },
    editElsewhere(path, change) {
      const current = required(path);
      const next = put(path, change.body ?? current.body ?? "", { ...current.frontmatter, ...change.patch } as Frontmatter);
      emit("mdbase.record.modified", { path, revision: next.revision });
      return copy(next);
    },
    renameElsewhere(from, to) {
      const current = required(from);
      stored.delete(from);
      const next = put(to, current.body ?? "", current.frontmatter);
      emit("mdbase.record.renamed", { from, to, revision: next.revision });
      return copy(next);
    },
    deleteElsewhere(path) {
      required(path);
      stored.delete(path);
      emit("mdbase.record.deleted", { path });
    },
    resetWatch() {
      const problem = connectProblem("change_cursor_reset", "Changes were missed.");
      for (const status of [...statuses]) status({ state: "reset_required", cursor, problem });
    },
    loseNextResponse() { loseNext = true; },
    failNextWrite(problem) { failNext = problem; }
  };
}
