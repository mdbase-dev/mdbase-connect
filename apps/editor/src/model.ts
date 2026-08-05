import type {
  CollectionDescription,
  CollectionChange,
  CollectionTypeDocument,
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
  TypePackAssessment,
  WatchStatus
} from "@mdbase-dev/connect";

export type TypePackApplyResult = import("@mdbase-dev/connect").TypePackApplyResult;

export type NoteFrontmatter = JsonObject;

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
}

export type CollectionSessionSnapshot =
  | { status: "unselected"; connections: ConnectionSummary[] }
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

export interface SaveNoteInput {
  path: string;
  title: string;
  body: string;
  source: TitleSource;
  revision: string;
  frontmatter: JsonObject;
}

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

export interface CollectionGateway {
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
  describe(): Promise<CollectionDescription>;
  list(options?: NoteIndexRequest): Promise<NoteIndexResult>;
  hydrateContent(options?: NoteContentRequest): Promise<NoteIndexResult>;
  read(path: string): Promise<NoteDocument>;
  create(input: CreateNoteInput): Promise<NoteDocument>;
  restore(document: NoteDocument): Promise<NoteDocument>;
  update(input: SaveNoteInput): Promise<NoteDocument>;
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
  watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal, onStatus?: (status: WatchStatus) => void): Promise<void>;
}

export interface CollectionAuthorizationOptions {
  signal?: AbortSignal;
}

export type TypeDocument = CollectionTypeDocument;
