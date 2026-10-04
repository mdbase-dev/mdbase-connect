import type {
  CollectionDescription,
  DescribeOptions,
  CollectionFileDescriptor,
  CollectionTypeDocument,
  MdbaseFileProgress,
  MdbaseFileSource,
  JsonObject,
  MdbaseDiagnostic,
  MutationProgress,
  MdbaseUnavailableReason,
  RenamePreflightResult,
  DeletePreflightResult,
  DirectAccessStatus,
  RecordDocument,
  QueryRecord,
  TypePackProvision,
  TypePackAssessment
} from "@mdbase-dev/connect";

export type TypePackApplyResult = import("@mdbase-dev/connect").TypePackApplyResult;

export type NoteFrontmatter = JsonObject;
export type CollectionFile = CollectionFileDescriptor;

export interface NoteSummary extends QueryRecord<NoteFrontmatter> {
  frontmatter: NoteFrontmatter;
  effectiveFrontmatter: NoteFrontmatter;
  /** mdbase-next only: whether the replica's log has confirmed this version yet. */
  syncState?: "pending" | "confirmed";
  /** mdbase-next only: the replica holds this file until the user resolves it. */
  hold?: CollectionHold["reason"];
}

/** "Confirmed through N, plus pending" (mdbase-next replicas only). */
export interface CollectionSyncStatus {
  confirmedThrough: number;
  pending: number;
  connection: "online" | "connecting" | "offline";
  holds: number;
  unresolved: number;
}

/**
 * The note list's synchronization owner. Connect's `MdbaseQueryObserver`
 * satisfies it; the mdbase-next gateway supplies a windowed live query.
 */
export interface NoteObservation {
  readonly ready: Promise<import("@mdbase-dev/connect").ConnectOutcome<void>>;
  getSnapshot(): import("@mdbase-dev/connect").ObserveSnapshot<NoteFrontmatter>;
  subscribe(listener: (
    snapshot: import("@mdbase-dev/connect").ObserveSnapshot<NoteFrontmatter>,
    delta: import("@mdbase-dev/connect").ObserveDelta<NoteFrontmatter>
  ) => void): () => void;
  subscribeChanges(listener: (change: import("@mdbase-dev/connect").CollectionChange) => void): () => void;
  /** Upgrade to body-bearing rows (full-text search and backlinks). */
  hydrate(): Promise<import("@mdbase-dev/connect").ConnectOutcome<void>>;
  refresh(): Promise<import("@mdbase-dev/connect").ConnectOutcome<void>>;
  optimistic(
    upserts?: readonly import("@mdbase-dev/connect").QueryRecord<NoteFrontmatter>[],
    removed?: readonly string[]
  ): import("@mdbase-dev/connect").ObserveOverlay;
  close(): void;
  /** Windowed observations: whether rows exist beyond the current window. */
  hasMore?(): boolean;
  /** Windowed observations: widen the window by one page. */
  loadMore?(): Promise<void>;
  /** mdbase-next only: the replica's sync status, pushed. */
  subscribeSync?(listener: (status: CollectionSyncStatus) => void): () => void;
}

export type NoteDocument = RecordDocument<NoteFrontmatter>;

export interface CollectionSnapshot {
  description: CollectionDescription;
  notes: NoteSummary[];
}

export interface ConnectionSummary {
  collectionId: string;
  displayName?: string;
  operations: string[];
  missingCapabilities?: string[];
  authorityKind?: "hosted" | "connector";
  directAccess?: DirectAccessStatus;
  fileActions?: string[];
}

export type CollectionSessionSnapshot =
  | { status: "unselected"; connections: ConnectionSummary[] }
  | {
      status: "start_failed";
      problem: { message: string; recovery: string };
      connections: ConnectionSummary[];
    }
  | { status: "destroyed"; connections: ConnectionSummary[] }
  | { status: "ready"; connection: ConnectionSummary; connections: ConnectionSummary[] }
  | {
      status: "unavailable";
      collectionId: string;
      reason: MdbaseUnavailableReason;
      connections: ConnectionSummary[];
    };

export type CollectionAuthorizationTarget =
  | "choose"
  | "selected"
  | { collectionId: string };

export interface CreateNoteInput {
  title: string;
  body: string;
  path: string;
  type?: string;
  titleField?: string;
  properties: JsonObject;
}

export interface RenamePreflight {
  affectedPaths: string[];
  warnings: string[];
  operation: RenamePreflightResult;
}

export interface DeletePreflight {
  brokenLinkPaths: string[];
  operation: DeletePreflightResult;
}

/**
 * Connect reports rename/delete phases. mdbase-next submits one intent, so it adds
 * `submitted`: the replica captured the change, which can no longer be cancelled.
 */
export type NoteMutationProgress = Omit<MutationProgress, "state"> & {
  state: MutationProgress["state"] | "submitted";
};

/** A file the replica is holding back until the user decides (mdbase-next §8.1). */
export interface CollectionHold {
  id: string;
  path: string;
  reason: "conflict" | "unknown_provenance" | "deleted_elsewhere" | "read_only" | "editor_busy" | "suspect_write";
  since: number;
  /** User saves collected while held. */
  saves: number;
  /** Whether a confirmed version exists to take instead (absent when deleted elsewhere). */
  hasTheirs: boolean;
}

export type HoldResolution = "keep_mine" | "take_theirs" | "use" | "delete" | "keep_both";

/** A merge the log recorded; what was kept is live, what was lost can be restored. */
export interface CollectionConflict {
  /** Stable key for resolving: mutation, record and field. */
  key: string;
  recordId: string;
  path?: string;
  kind: "field" | "frontmatter" | "body" | "path" | "delete" | "file";
  field?: string;
  kept: string;
  lost: string;
  /** Whether "use the lost value" can be applied (field values and body text). */
  restorable: boolean;
}

export interface SyncAttention {
  holds: CollectionHold[];
  conflicts: CollectionConflict[];
}

export interface MutationOperationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: NoteMutationProgress) => void;
}

export type TitleSource =
  | { kind: "frontmatter"; field: string }
  | { kind: "heading" };

export interface EditableNote {
  title: string;
  body: string;
  source: TitleSource;
}

export interface NoteListProgress {
  notes: NoteSummary[];
  snapshot?: string;
  structureComplete: boolean;
  complete: boolean;
  total?: number;
  contentComplete?: boolean;
  contentLoaded?: number;
}

export interface NoteIndexResult {
  notes: NoteSummary[];
  snapshot?: string;
}

export interface NoteIndexRequest {
  signal?: AbortSignal;
  onProgress?: (progress: NoteListProgress) => void;
}

export interface NoteContentRequest extends NoteIndexRequest {
  snapshot?: string;
}

export interface FileListProgress {
  files: CollectionFile[];
  complete: boolean;
}

export interface FileListRequest {
  signal?: AbortSignal;
  onProgress?: (progress: FileListProgress) => void;
}

export interface FileReadRequest {
  signal?: AbortSignal;
  onProgress?: (progress: MdbaseFileProgress) => void;
}

export interface FileUploadRequest extends FileReadRequest {
  transferId?: string;
}

export interface CollectionGateway {
  pendingNoteMutations(): readonly import("@mdbase-dev/connect").PendingMutationSummary[];
  recoverNoteMutation(requestId: string): Promise<NoteDocument>;
  sessionSnapshot(): CollectionSessionSnapshot;
  startSession(): Promise<CollectionSessionSnapshot>;
  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void): () => void;
  selectConnection(collectionId: string): ConnectionSummary;
  checkDirectAccess(): Promise<ConnectionSummary | null>;
  requestDirectAccess(): Promise<ConnectionSummary | null>;
  authorize(
    target: CollectionAuthorizationTarget,
    options?: CollectionAuthorizationOptions
  ): Promise<void>;
  forgetConnection(collectionId: string): void;
  describe(options?: DescribeOptions): Promise<CollectionDescription>;
  /** Demo collections have no authenticated account. Members are never read here. */
  peopleDirectory?(options?: { signal?: AbortSignal }): Promise<import("@mdbase-dev/connect").PeopleDirectory>;
  /** Every page of one contract/type projection. */
  queryContract?(
    contract: import("@mdbase-dev/connect").DataContractSelector,
    options?: { signal?: AbortSignal }
  ): Promise<Array<{ path: string; values: import("@mdbase-dev/connect").JsonObject }>>;
  observe(options?: import("@mdbase-dev/connect").ObserveOptions): NoteObservation;
  /**
   * Problems that surface after a call returned, such as an optimistic write
   * the replica later rejected. Optional: Connect reports every failure inline.
   */
  onBackgroundProblem?(listener: (message: string) => void): () => void;
  /** Holds and conflicts to review (mdbase-next); Connect reports none. */
  onSyncAttention?(listener: (attention: SyncAttention) => void): () => void;
  resolveHold?(id: string, how: HoldResolution, use?: string): Promise<void>;
  /** Keep what the merge kept (`"kept"`), or restore the lost value (`"lost"`). */
  resolveConflict?(key: string, choice: "kept" | "lost"): Promise<void>;
  mostRecentNote(): Promise<string | undefined>;
  read(path: string): Promise<NoteDocument>;
  listFiles(options?: FileListRequest): Promise<CollectionFile[]>;
  readFile(file: CollectionFile, options?: FileReadRequest): Promise<Blob>;
  uploadFile(path: string, source: MdbaseFileSource, options?: FileUploadRequest): Promise<CollectionFile>;
  create(input: CreateNoteInput): Promise<NoteDocument>;
  restore(document: NoteDocument): Promise<NoteDocument>;
  /** Revision-checked write of only the changed parts, against `base`. */
  update(base: NoteDocument, change: import("@mdbase-dev/connect/advanced").MdbaseRecordChange): Promise<NoteDocument>;
  updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument>;
  updateDocument(path: string, document: string, revision: string): Promise<NoteDocument>;
  preflightRename(from: string, to: string, revision: string): Promise<RenamePreflight>;
  rename(from: string, to: string, revision: string, updateRefs?: boolean, options?: MutationOperationOptions): Promise<NoteDocument>;
  preflightDelete(path: string, revision: string): Promise<DeletePreflight>;
  delete(path: string, revision: string, options?: MutationOperationOptions): Promise<void>;
  validate(path: string): Promise<MdbaseDiagnostic[]>;
  readType(name: string): Promise<CollectionTypeDocument>;
  createType(document: string): Promise<CollectionTypeDocument>;
  updateType(document: CollectionTypeDocument, source: string): Promise<CollectionTypeDocument>;
  assessTypePack(
    provision: TypePackProvision,
    adoptResources?: Record<string, string>,
  ): Promise<TypePackAssessment>;
  applyTypePack(
    provision: TypePackProvision,
    assessment: TypePackAssessment,
    adoptResources?: Record<string, string>,
  ): Promise<TypePackApplyResult>;
}

export interface CollectionAuthorizationOptions {
  signal?: AbortSignal;
  presentation?: "redirect" | "popup";
}

export type TypeDocument = CollectionTypeDocument;
