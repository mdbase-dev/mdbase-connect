import type {
  CollectionDescription,
  CollectionChange,
  CollectionFileMetadata,
  JsonObject,
  MdbaseDiagnostic,
  RecordResult,
  RecordSummary
} from "@mdbase/connect";

export type NoteFrontmatter = JsonObject;

export interface NoteSummary extends RecordSummary<NoteFrontmatter> {
  file?: CollectionFileMetadata;
}

export interface NoteDocument extends RecordResult<NoteFrontmatter> {
  file?: CollectionFileMetadata;
}

export interface CollectionSnapshot {
  description: CollectionDescription;
  notes: NoteSummary[];
}

export interface ConnectionSummary {
  collectionId: string;
  operations: string[];
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
  complete: boolean;
  total?: number;
}

export interface CollectionGateway {
  connection(): ConnectionSummary | null;
  authorize(): Promise<void>;
  completeAuthorization(): Promise<void>;
  disconnect(): void;
  describe(): Promise<CollectionDescription>;
  list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]>;
  read(path: string): Promise<NoteDocument>;
  create(input: CreateNoteInput): Promise<NoteDocument>;
  update(input: SaveNoteInput): Promise<NoteDocument>;
  updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument>;
  rename(from: string, to: string, revision: string): Promise<NoteDocument>;
  delete(path: string, revision: string): Promise<void>;
  validate(path: string): Promise<MdbaseDiagnostic[]>;
  watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal): Promise<void>;
}
