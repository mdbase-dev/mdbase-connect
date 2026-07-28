import type {
  CollectionDescription,
  CollectionChange,
  CollectionTypeDocument,
  JsonObject,
  MdbaseDiagnostic,
  MutationProgress,
  RenamePreflightResult,
  DeletePreflightResult,
  DirectAccessStatus,
  MdbaseConnectionRoute,
  RecordDocument,
  QueryRecord,
  WatchStatus
} from "@mdbase/connect";

export type NoteFrontmatter = JsonObject;

export interface NoteSummary extends QueryRecord<NoteFrontmatter> {
  frontmatter: NoteFrontmatter;
  effective_frontmatter: NoteFrontmatter;
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
  missingOperations?: string[];
  route?: MdbaseConnectionRoute;
  directAccess?: DirectAccessStatus;
}

export interface SaveNoteInput {
  path: string;
  title: string;
  body: string;
  source: TitleSource;
  revision: string;
}

export interface CreateNoteInput {
  title: string;
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
  structureComplete: boolean;
  complete: boolean;
  total?: number;
  contentComplete?: boolean;
  contentLoaded?: number;
}

export interface CollectionGateway {
  connection(): ConnectionSummary | null;
  connections(): ConnectionSummary[];
  authorizationTarget(): string | null;
  selectConnection(collectionId: string): void;
  onConnectionChange(listener: (connection: ConnectionSummary | null) => void): () => void;
  checkDirectAccess(): Promise<ConnectionSummary | null>;
  requestDirectAccess(): Promise<ConnectionSummary | null>;
  authorize(collectionId?: string): Promise<void>;
  authorizeNewCollection(): Promise<void>;
  completeAuthorization(): Promise<void>;
  disconnect(): void;
  describe(): Promise<CollectionDescription>;
  list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]>;
  hydrateContent(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]>;
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
  watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal, onStatus?: (status: WatchStatus) => void): Promise<void>;
}

export type TypeDocument = CollectionTypeDocument;
