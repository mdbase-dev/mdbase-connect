import {
  MdbaseConnect,
  MdbaseConnectError,
  unwrapOperation,
  type CollectionDescription,
  type MdbaseOperation as CollectionOperation,
  type JsonObject,
  type MdbaseDiagnostic,
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
  RenamePreflight,
  DeletePreflight,
  MutationOperationOptions,
  SaveNoteInput
} from "./model";

export const CORE_COLLECTION_OPERATIONS: CollectionOperation[] = [
  "describe",
  "changes",
  "read",
  "query",
  "validate",
  "create",
  "update",
  "delete",
  "rename"
];

export const TYPE_DEFINITION_OPERATIONS: CollectionOperation[] = [
  "read_type",
  "create_type",
  "update_type"
];

export const FULL_COLLECTION_OPERATIONS: CollectionOperation[] = [
  ...CORE_COLLECTION_OPERATIONS,
  ...TYPE_DEFINITION_OPERATIONS
];

export function missingCoreOperations(connection: ConnectionSummary | null): string[] {
  return connection?.missingOperations?.filter((operation) =>
    CORE_COLLECTION_OPERATIONS.includes(operation as CollectionOperation)
  ) ?? [];
}

export function missingTypeOperations(connection: ConnectionSummary | null): string[] {
  return connection?.missingOperations?.filter((operation) =>
    TYPE_DEFINITION_OPERATIONS.includes(operation as CollectionOperation)
  ) ?? [];
}

const FIRST_PAGE_SIZE = 200;
const PAGE_SIZE = 1_000;

export class ConnectCollectionGateway implements CollectionGateway {
  private readonly connect: MdbaseConnect<NoteFrontmatter>;
  private indexSnapshot?: string;
  private readonly renamePreflights = new Map<string, import("@mdbase/connect").RenamePreflightResult>();
  private readonly deletePreflights = new Map<string, import("@mdbase/connect").DeletePreflightResult>();

  constructor(serverUrl = import.meta.env.VITE_MDBASE_CONNECT_URL ?? "https://connect.mdbase.dev") {
    const appRoot = new URL(import.meta.env.BASE_URL, location.href);
    this.connect = new MdbaseConnect({
      serverUrl,
      manifest: new URL(".well-known/mdbase-app.json", appRoot).href,
      redirectUri: appRoot.href
    });
  }

  connection(): ConnectionSummary | null {
    const connection = this.connect.connection();
    if (!connection) return null;
    return {
      collectionId: connection.collectionId,
      operations: connection.operations,
      missingOperations: this.connect.authorizationCapabilities(FULL_COLLECTION_OPERATIONS).missingOperations
    };
  }

  onConnectionChange(listener: (connection: ConnectionSummary | null) => void): () => void {
    return this.connect.onConnectionChange(() => listener(this.connection()));
  }

  async authorize(): Promise<void> {
    await this.connect.requestOperations(FULL_COLLECTION_OPERATIONS);
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
    let snapshot: string | undefined;
    for await (const page of this.connect.queryPages({
        order_by: [{ field: "file.mtime", direction: "desc" }],
        include_body: false
      }, { firstPageSize: FIRST_PAGE_SIZE, pageSize: PAGE_SIZE })) {
      notes.push(...page.results);
      snapshot = page.snapshot;
      onProgress?.({
        notes: [...notes],
        structureComplete: page.complete,
        complete: page.complete,
        contentComplete: notes.length === 0,
        contentLoaded: 0,
        total: page.meta?.total_count
      });
    }

    this.indexSnapshot = snapshot;
    return notes;
  }

  async hydrateContent(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    const notes: NoteSummary[] = [];
    let snapshot = this.indexSnapshot;
    for await (const page of this.connect.queryPages({
        order_by: [{ field: "file.mtime", direction: "desc" }],
        ...(snapshot ? { snapshot } : {}),
        include_body: true
      }, { firstPageSize: FIRST_PAGE_SIZE, pageSize: PAGE_SIZE })) {
      notes.push(...page.results);
      snapshot = page.snapshot;
      onProgress?.({
        notes: [...notes],
        structureComplete: true,
        complete: page.complete,
        contentComplete: page.complete,
        contentLoaded: notes.length,
        total: page.meta?.total_count
      });
    }
    this.indexSnapshot = snapshot;
    return notes;
  }

  async read(path: string): Promise<NoteDocument> {
    return unwrapOperation(await this.connect.read({ path }));
  }

  async create(input: CreateNoteInput): Promise<NoteDocument> {
    return unwrapOperation(await this.connect.create({
      path: input.path,
      ...(input.type ? { type: input.type } : {}),
      frontmatter: input.properties,
      body: input.titleField ? "" : `# ${input.title}\n`
    }));
  }

  async restore(document: NoteDocument): Promise<NoteDocument> {
    return unwrapOperation(await this.connect.create({
      path: document.path,
      frontmatter: document.raw_frontmatter ?? document.frontmatter,
      body: document.body ?? ""
    }));
  }

  async update(input: SaveNoteInput): Promise<NoteDocument> {
    return unwrapOperation(await this.connect.update({
      path: input.path,
      patch: titlePatch(input.title, input.source),
      body: persistedBody(input.title, input.body, input.source),
      if_revision: input.revision
    }));
  }

  async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    return unwrapOperation(await this.connect.update({ path, patch, if_revision: revision }));
  }

  async preflightRename(from: string, to: string, revision: string): Promise<RenamePreflight> {
    const result = unwrapOperation(await this.connect.preflightRename({
      from,
      to,
      if_revision: revision,
      update_refs: true
    }));
    this.renamePreflights.set(mutationKey(from, to, revision), result);
    return {
      affectedPaths: uniquePaths(result.references_affected),
      warnings: [...new Set(result.warnings?.map((warning) => warning.message) ?? [])],
      operation: result
    };
  }

  async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    const key = mutationKey(from, to, revision);
    let retainPreflight = false;
    try {
      return unwrapOperation(await this.connect.renameWithProgress({
        from,
        to,
        if_revision: revision,
        update_refs: updateRefs
      }, {
        ...(this.renamePreflights.get(key) ? { preflight: this.renamePreflights.get(key) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {})
      }));
    } catch (error) {
      retainPreflight = error instanceof MdbaseConnectError && error.outcomeUnknown;
      throw error;
    } finally {
      if (!retainPreflight) this.renamePreflights.delete(key);
    }
  }

  async preflightDelete(path: string, revision: string): Promise<DeletePreflight> {
    const result = unwrapOperation(await this.connect.preflightDelete({ path, if_revision: revision }));
    this.deletePreflights.set(mutationKey(path, "", revision), result);
    return { brokenLinkPaths: uniquePaths(result.broken_links), operation: result };
  }

  async delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
    const key = mutationKey(path, "", revision);
    let retainPreflight = false;
    try {
      unwrapOperation(await this.connect.deleteWithProgress({
        path,
        if_revision: revision,
        check_backlinks: true
      }, {
        ...(this.deletePreflights.get(key) ? { preflight: this.deletePreflights.get(key) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {})
      }));
    } catch (error) {
      retainPreflight = error instanceof MdbaseConnectError && error.outcomeUnknown;
      throw error;
    } finally {
      if (!retainPreflight) this.deletePreflights.delete(key);
    }
  }

  async validate(path: string): Promise<MdbaseDiagnostic[]> {
    const response = await this.connect.validate({ path });
    return response.diagnostics;
  }

  async readType(name: string) {
    return unwrapOperation(await this.connect.readType({ name }));
  }

  async createType(document: string) {
    return unwrapOperation(await this.connect.createType({ document }));
  }

  async updateType(current: import("./model").TypeDocument, document: string) {
    return unwrapOperation(await this.connect.updateType({
      path: current.path,
      document,
      if_revision: current.revision
    }));
  }

  async watch(onChange: (change: import("@mdbase/connect").CollectionChange) => void, signal: AbortSignal, onStatus?: (status: import("@mdbase/connect").WatchStatus) => void): Promise<void> {
    for await (const change of this.connect.watch({ signal, pollIntervalMs: 1_500, onStatus })) {
      if (change.type.startsWith("mdbase.record.") || change.type === "mdbase.type.changed") onChange(change);
    }
  }
}

function uniquePaths(values: Array<{ path: string }> | undefined): string[] {
  return [...new Set(values?.map((value) => value.path) ?? [])];
}

function mutationKey(from: string, to: string, revision: string): string {
  return JSON.stringify([from, to, revision]);
}

export function gatewayError(error: unknown): string {
  if (error instanceof MdbaseConnectError) {
    if (error.code === "connector_offline") return "The computer holding this collection is offline.";
    if (error.requiresAuthorization) {
      return "This collection needs authorization again. Choose the collection to continue.";
    }
  }
  if (error instanceof Error) return error.message;
  return "The collection could not be reached.";
}

export type { QueryResult };
