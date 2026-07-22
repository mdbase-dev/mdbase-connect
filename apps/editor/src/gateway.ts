import {
  MdbaseConnect,
  MdbaseConnectError,
  type CollectionDescription,
  type MdbaseOperation as CollectionOperation,
  type JsonObject,
  type MdbaseDiagnostic,
  type MdbaseOperationEnvelope,
  type QueryResult
} from "@mdbase/connect";
import { persistedBody, titlePatch } from "./note";
import type {
  CollectionGateway,
  ConnectionSummary,
  CreateNoteInput,
  NoteDocument,
  NoteFrontmatter,
  NoteListProgress,
  NoteSummary,
  SaveNoteInput
} from "./model";

export const FULL_COLLECTION_OPERATIONS: CollectionOperation[] = [
  "describe",
  "changes",
  "read",
  "query",
  "validate",
  "create",
  "update",
  "delete",
  "rename",
  "read_type",
  "create_type",
  "update_type"
];

const FIRST_PAGE_SIZE = 200;
const PAGE_SIZE = 1_000;

export class ConnectCollectionGateway implements CollectionGateway {
  private readonly connect: MdbaseConnect<NoteFrontmatter>;

  constructor(serverUrl = import.meta.env.VITE_MDBASE_CONNECT_URL ?? "https://connect.mdbase.dev") {
    const appRoot = new URL(import.meta.env.BASE_URL, location.href);
    this.connect = new MdbaseConnect({
      serverUrl,
      manifestUrl: new URL(".well-known/mdbase-app.json", appRoot).href,
      redirectUri: appRoot.href
    });
  }

  connection(): ConnectionSummary | null {
    return this.connect.connection();
  }

  onConnectionChange(listener: (connection: ConnectionSummary | null) => void): () => void {
    return this.connect.onConnectionChange(listener);
  }

  checkDirectAccess() {
    return this.connect.checkDirectAccess();
  }

  requestDirectAccess() {
    return this.connect.requestDirectAccess();
  }

  async authorize(): Promise<void> {
    await this.connect.authorize(FULL_COLLECTION_OPERATIONS);
  }

  async completeAuthorization(): Promise<void> {
    await this.connect.completeAuthorization();
  }

  disconnect(): void {
    this.connect.disconnect();
  }

  describe(): Promise<CollectionDescription> {
    return this.connect.describe();
  }

  async list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    const notes: NoteSummary[] = [];
    const noteIndexes = new Map<string, number>();
    let offset = 0;
    let snapshot: string | undefined;

    // Establish the complete collection shape first. Omitting bodies makes paths,
    // folders, counts, and frontmatter available without waiting for search data.
    do {
      const limit = offset === 0 ? FIRST_PAGE_SIZE : PAGE_SIZE;
      const response = await this.connect.query({
        order_by: [{ field: "file.mtime", direction: "desc" }],
        limit,
        offset,
        ...(snapshot ? { snapshot } : {}),
        include_body: false
      });
      const result = validResult(response);
      if (!snapshot && typeof result.meta?.snapshot === "string") snapshot = result.meta.snapshot;
      for (const note of result.results) {
        noteIndexes.set(note.path, notes.length);
        notes.push(note);
      }
      offset += result.results.length;
      const structureComplete = !result.meta?.has_more || result.results.length === 0;
      onProgress?.({
        notes: [...notes],
        structureComplete,
        complete: structureComplete && notes.length === 0,
        total: result.meta?.total_count
      });
      if (structureComplete) break;
    } while (true);

    // Hydrate bodies in the background so local full-text search becomes complete.
    offset = 0;
    while (notes.length > 0) {
      const limit = offset === 0 ? FIRST_PAGE_SIZE : PAGE_SIZE;
      const response = await this.connect.query({
        order_by: [{ field: "file.mtime", direction: "desc" }],
        limit,
        offset,
        ...(snapshot ? { snapshot } : {}),
        include_body: true
      });
      const result = validResult(response);
      for (const note of result.results) {
        const index = noteIndexes.get(note.path);
        if (index === undefined) {
          noteIndexes.set(note.path, notes.length);
          notes.push(note);
        } else {
          notes[index] = note;
        }
      }
      offset += result.results.length;
      const complete = !result.meta?.has_more || result.results.length === 0;
      onProgress?.({
        notes: [...notes],
        structureComplete: true,
        complete,
        total: result.meta?.total_count
      });
      if (complete) break;
    }
    return notes;
  }

  async read(path: string): Promise<NoteDocument> {
    return validResult(await this.connect.read({ path }));
  }

  async create(input: CreateNoteInput): Promise<NoteDocument> {
    return validResult(await this.connect.create({
      path: input.path,
      ...(input.type ? { type: input.type } : {}),
      frontmatter: input.properties,
      body: input.titleField ? "" : `# ${input.title}\n`
    }));
  }

  async update(input: SaveNoteInput): Promise<NoteDocument> {
    return validResult(await this.connect.update({
      path: input.path,
      patch: titlePatch(input.title, input.source),
      body: persistedBody(input.title, input.body, input.source),
      if_revision: input.revision
    }));
  }

  async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    return validResult(await this.connect.update({ path, patch, if_revision: revision }));
  }

  async rename(from: string, to: string, revision: string): Promise<NoteDocument> {
    return validResult(await this.connect.rename({
      from,
      to,
      if_revision: revision,
      update_refs: true
    }));
  }

  async delete(path: string, revision: string): Promise<void> {
    validResult(await this.connect.delete({ path, if_revision: revision, check_backlinks: true }));
  }

  async validate(path: string): Promise<MdbaseDiagnostic[]> {
    const response = await this.connect.validate({ path });
    return response.diagnostics;
  }

  async watch(onChange: (change: import("@mdbase/connect").CollectionChange) => void, signal: AbortSignal): Promise<void> {
    for await (const change of this.connect.watch({ signal, pollIntervalMs: 1_500 })) {
      if (change.type.startsWith("mdbase.record.") || change.type === "mdbase.type.changed") onChange(change);
    }
  }
}

export class CollectionOperationError extends Error {
  constructor(public readonly diagnostics: MdbaseDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join(" ") || "The collection rejected this change.");
  }
}

function validResult<Result>(envelope: MdbaseOperationEnvelope<Result>): Result {
  if (!envelope.valid) throw new CollectionOperationError(envelope.diagnostics);
  return envelope.result;
}

export function gatewayError(error: unknown): string {
  if (error instanceof MdbaseConnectError) {
    if (error.code === "connector_offline") return "The computer holding this collection is offline.";
    if (error.code === "not_authorized" || error.code === "authorization_expired") {
      return "This connection has expired. Connect the collection again.";
    }
  }
  if (error instanceof Error) return error.message;
  return "The collection could not be reached.";
}

export type { QueryResult };
