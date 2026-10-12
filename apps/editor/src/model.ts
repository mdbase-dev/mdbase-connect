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

/** `names_only`: the native SDK describe has type names, paths and contract
 * bindings but no type schemas/versions or contract schemas/implementation
 * digests. Those fields are then empty and must not drive upgrade decisions. */
export type EditorCollectionDescription = CollectionDescription & { readonly typing?: "names_only" };
export type CollectionFile = CollectionFileDescriptor;

export interface NoteSummary extends QueryRecord<NoteFrontmatter> {
  frontmatter: NoteFrontmatter;
  effectiveFrontmatter: NoteFrontmatter;
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

export interface MutationOperationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: MutationProgress) => void;
}

export type TitleSource =
  | { kind: "frontmatter"; field: string }
  | { kind: "heading" }
  /** No title in the record: the filename stands in until the person changes it. */
  | { kind: "path"; title: string };

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
  /** Undefined only when the exact recovered operation was a confirmed delete. */
  recoverNoteMutation(requestId: string): Promise<NoteDocument | undefined>;
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
  forgetConnection(collectionId: string): void | Promise<void>;
  describe(options?: DescribeOptions): Promise<CollectionDescription>;
  /** Demo collections have no authenticated account. Members are never read here. */
  peopleDirectory?(options?: { signal?: AbortSignal }): Promise<import("@mdbase-dev/connect").PeopleDirectory>;
  /** Every page of one contract/type projection. */
  queryContract?(
    contract: import("@mdbase-dev/connect").DataContractSelector,
    options?: { signal?: AbortSignal }
  ): Promise<Array<{ path: string; values: import("@mdbase-dev/connect").JsonObject }>>;
  /** Absent where sync is not the gateway's to report (demo, Connect). */
  syncState?(): import("./app-state-types").EditorSyncState;
  onSyncState?(listener: () => void): () => void;
  observe(): NoteObservation;
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

/** Native observation failure: the original SDK error, never a synthesized Connect problem. */
export interface NativeObservationProblem {
  source: "native";
  code: string;
  message: string;
  error: unknown;
}
export type ObservationProblem = import("@mdbase-dev/connect").ConnectProblem | NativeObservationProblem;
export type ObservationOutcome = { ok: true } | { ok: false; problem: ObservationProblem };
/** Presentation subset of watch state; the Connect observer's status satisfies it. */
export type ObservationWatchStatus =
  | { state: "connecting" | "connected" | "closed" }
  | { state: "reconnecting" | "reset_required"; problem: { message: string } };
export interface NoteObservationSnapshot {
  readonly records: readonly QueryRecord<NoteFrontmatter>[];
  readonly state: "loading" | "ready" | "error" | "closed";
  readonly generation: number;
  readonly total?: number;
  readonly problem: ObservationProblem | null;
  readonly watchStatus: ObservationWatchStatus | null;
}
/** Record membership changes reported by a native observation. Its reset
 * carries no Connect event cursor or raw wire payload. */
export type NativeCollectionChange =
  | { source: "native"; kind: "record.created" | "record.updated" | "record.deleted"; path: string; revision?: string }
  | { source: "native"; kind: "record.renamed"; from: string; to: string; revision?: string }
  | { source: "native"; kind: "reset" };
export type EditorCollectionChange = import("@mdbase-dev/connect").CollectionChange | NativeCollectionChange;
/** The collection-owned index observation the editor consumes. Implemented by
 * the Connect observer and by the native SDK observation; not a second index. */
export interface NoteObservation {
  readonly ready: Promise<ObservationOutcome>;
  getSnapshot(): NoteObservationSnapshot;
  subscribe(listener: (snapshot: NoteObservationSnapshot, delta: { readonly reason: "page" | "reload" | "changes" | "local" | "status" }) => void): () => void;
  subscribeChanges(listener: (change: EditorCollectionChange) => void): () => void;
  refresh(): Promise<ObservationOutcome>;
  hydrate(): Promise<ObservationOutcome>;
  /** Commit only after the write succeeds; a later reread retires a committed overlay. */
  optimistic(upserts: readonly QueryRecord<NoteFrontmatter>[], removed?: readonly string[]): { commit(): void; rollback(): void };
  close(): void;
}

export interface CollectionAuthorizationOptions {
  signal?: AbortSignal;
  presentation?: "redirect" | "popup";
}

export type TypeDocument = CollectionTypeDocument;
