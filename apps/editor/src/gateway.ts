import {
  MdbaseBrowserSelection,
  MdbaseConnect,
  MdbaseConnectError,
  ConnectOutcomeError,
  unwrapConnectOutcome,
  type CollectionDescription,
  type MdbaseConnection,
  type MdbaseConnectionInfo,
  type MdbaseOperation as CollectionOperation,
  type MdbaseSession,
  type MdbaseSessionSnapshot,
  type JsonObject,
  type MdbaseDiagnostic,
  type QueryRecord,
  type QueryResult,
  type TypePackProvision
} from "@mdbase-dev/connect";
import { persistedBody, titlePatch } from "./note";
import type {
  CollectionGateway,
  CollectionAuthorizationTarget,
  CollectionSessionSnapshot,
  ConnectionSummary,
  CreateNoteInput,
  NoteDocument,
  NoteContentRequest,
  NoteIndexRequest,
  NoteIndexResult,
  NoteFrontmatter,
  NoteSummary,
  RenamePreflight,
  DeletePreflight,
  MutationOperationOptions,
  SaveNoteInput,
  TypePackInstallResult
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

const INSTALL_TYPE_PACK_OPERATION: CollectionOperation = "install_type_pack";

export const FULL_COLLECTION_OPERATIONS: CollectionOperation[] = [
  ...CORE_COLLECTION_OPERATIONS,
  ...TYPE_DEFINITION_OPERATIONS,
  INSTALL_TYPE_PACK_OPERATION
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
  private readonly session: MdbaseSession<NoteFrontmatter>;
  private readonly renamePreflights = new Map<string, import("@mdbase-dev/connect").RenamePreflightResult>();
  private readonly deletePreflights = new Map<string, import("@mdbase-dev/connect").DeletePreflightResult>();

  constructor(serverUrl = new URLSearchParams(location.search).get("server")
      ?? import.meta.env.VITE_MDBASE_CONNECT_URL
      ?? "https://connect.mdbase.dev") {
    const appRoot = new URL(import.meta.env.BASE_URL, location.href);
    const connect = new MdbaseConnect<NoteFrontmatter>({
      serverUrl,
      manifest: new URL(".well-known/mdbase-app.json", appRoot).href,
      redirectUri: appRoot.href
    });
    this.session = connect.createSession({
      operations: FULL_COLLECTION_OPERATIONS,
      selection: new MdbaseBrowserSelection({
        fallbackPath: appRoot.pathname
      }),
      autoSelect: "only"
    });
  }

  sessionSnapshot(): CollectionSessionSnapshot {
    return summarizeSession(this.session.getSnapshot());
  }

  async startSession(): Promise<CollectionSessionSnapshot> {
    return summarizeSession(unwrapConnectOutcome(await this.session.start()));
  }

  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void): () => void {
    const publish = () => listener(this.sessionSnapshot());
    const stop = this.session.subscribe(publish);
    publish();
    return stop;
  }

  selectConnection(collectionId: string): ConnectionSummary {
    unwrapConnectOutcome(this.session.select(collectionId, { history: "replace" }));
    const snapshot = this.sessionSnapshot();
    if (snapshot.status !== "ready") {
      throw new Error("The selected collection is not ready.");
    }
    return snapshot.connection;
  }

  async checkDirectAccess(): Promise<ConnectionSummary | null> {
    const connection = this.activeConnection();
    if (!connection) return null;
    unwrapConnectOutcome(await connection.checkDirectAccess());
    return this.readySummary();
  }

  async requestDirectAccess(): Promise<ConnectionSummary | null> {
    const connection = this.activeConnection();
    if (!connection) return null;
    unwrapConnectOutcome(await connection.requestDirectAccess());
    return this.readySummary();
  }

  async authorize(target: CollectionAuthorizationTarget): Promise<void> {
    unwrapConnectOutcome(await this.session.authorize(target));
  }

  forgetConnection(collectionId: string): void {
    this.session.forget(collectionId);
  }

  async describe(): Promise<CollectionDescription> {
    return unwrapConnectOutcome(await this.requireConnection().describe());
  }

  async list({ signal, onProgress }: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    const notes: NoteSummary[] = [];
    let snapshot: string | undefined;
    for await (const outcome of this.requireConnection().queryPages({
        order_by: [{ field: "file.mtime", direction: "desc" }],
        include_body: false,
        frontmatter_mode: "both"
      }, { firstPageSize: FIRST_PAGE_SIZE, pageSize: PAGE_SIZE, signal })) {
      const page = unwrapConnectOutcome(outcome);
      notes.push(...page.results.map(completeSummary));
      snapshot = page.snapshot;
      onProgress?.({
        notes: [...notes],
        snapshot,
        structureComplete: page.complete,
        complete: page.complete,
        contentComplete: notes.length === 0,
        contentLoaded: 0,
        total: page.meta?.total_count
      });
    }

    return { notes, snapshot };
  }

  async hydrateContent({ snapshot: requestedSnapshot, signal, onProgress }: NoteContentRequest = {}): Promise<NoteIndexResult> {
    const notes: NoteSummary[] = [];
    let snapshot = requestedSnapshot;
    for await (const outcome of this.requireConnection().queryPages({
        order_by: [{ field: "file.mtime", direction: "desc" }],
        ...(snapshot ? { snapshot } : {}),
        include_body: true,
        frontmatter_mode: "both"
      }, { firstPageSize: FIRST_PAGE_SIZE, pageSize: PAGE_SIZE, signal })) {
      const page = unwrapConnectOutcome(outcome);
      notes.push(...page.results.map(completeSummary));
      snapshot = page.snapshot;
      onProgress?.({
        notes: [...notes],
        snapshot,
        structureComplete: true,
        complete: page.complete,
        contentComplete: page.complete,
        contentLoaded: notes.length,
        total: page.meta?.total_count
      });
    }
    return { notes, snapshot };
  }

  async read(path: string): Promise<NoteDocument> {
    return unwrapConnectOutcome(await this.requireConnection().read({ path, include_document: true }));
  }

  async create(input: CreateNoteInput): Promise<NoteDocument> {
    return unwrapConnectOutcome(await this.requireConnection().create({
      path: input.path,
      ...(input.type ? { type: input.type } : {}),
      frontmatter: input.properties,
      body: input.titleField
        ? input.body
        : persistedBody(input.title, input.body, { kind: "heading" }),
      include_document: true
    }));
  }

  async restore(document: NoteDocument): Promise<NoteDocument> {
    return unwrapConnectOutcome(await this.requireConnection().create({
      path: document.path,
      frontmatter: document.frontmatter,
      body: document.body,
      include_document: true
    }));
  }

  async update(input: SaveNoteInput): Promise<NoteDocument> {
    return unwrapConnectOutcome(await this.requireConnection().update({
      path: input.path,
      patch: titlePatch(input.title, input.source, input.frontmatter),
      body: persistedBody(input.title, input.body, input.source),
      if_revision: input.revision,
      include_document: true
    }));
  }

  async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    return unwrapConnectOutcome(await this.requireConnection().update({ path, patch, if_revision: revision, include_document: true }));
  }

  async updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> {
    return unwrapConnectOutcome(await this.requireConnection().update({
      path,
      document,
      if_revision: revision
    }));
  }

  async preflightRename(from: string, to: string, revision: string): Promise<RenamePreflight> {
    const result = unwrapConnectOutcome(await this.requireConnection().preflightRename({
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
      return unwrapConnectOutcome(await this.requireConnection().renameWithProgress({
        from,
        to,
        if_revision: revision,
        update_refs: updateRefs,
        include_document: true
      }, {
        ...(this.renamePreflights.get(key) ? { preflight: this.renamePreflights.get(key) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {})
      }));
    } catch (error) {
      retainPreflight = operationOutcomeUnknown(error);
      throw error;
    } finally {
      if (!retainPreflight) this.renamePreflights.delete(key);
    }
  }

  async preflightDelete(path: string, revision: string): Promise<DeletePreflight> {
    const result = unwrapConnectOutcome(await this.requireConnection().preflightDelete({ path, if_revision: revision }));
    this.deletePreflights.set(mutationKey(path, "", revision), result);
    return { brokenLinkPaths: uniquePaths(result.broken_links), operation: result };
  }

  async delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
    const key = mutationKey(path, "", revision);
    let retainPreflight = false;
    try {
      unwrapConnectOutcome(await this.requireConnection().deleteWithProgress({
        path,
        if_revision: revision,
        check_backlinks: true
      }, {
        ...(this.deletePreflights.get(key) ? { preflight: this.deletePreflights.get(key) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {})
      }));
    } catch (error) {
      retainPreflight = operationOutcomeUnknown(error);
      throw error;
    } finally {
      if (!retainPreflight) this.deletePreflights.delete(key);
    }
  }

  async validate(path: string): Promise<MdbaseDiagnostic[]> {
    const response = await this.requireConnection().validate({ path });
    if (!response.ok) throw new ConnectOutcomeError(response.problem);
    return response.diagnostics;
  }

  async readType(name: string) {
    return unwrapConnectOutcome(await this.requireConnection().readType({ name }));
  }

  async createType(document: string) {
    return unwrapConnectOutcome(await this.requireConnection().createType({ document }));
  }

  async updateType(current: import("./model").TypeDocument, document: string) {
    return unwrapConnectOutcome(await this.requireConnection().updateType({
      path: current.path,
      document,
      if_revision: current.revision
    }));
  }

  async installTypePack(provision: TypePackProvision): Promise<TypePackInstallResult> {
    return unwrapConnectOutcome(await this.requireConnection().installTypePack(provision));
  }

  async watch(onChange: (change: import("@mdbase-dev/connect").CollectionChange) => void, signal: AbortSignal, onStatus?: (status: import("@mdbase-dev/connect").WatchStatus) => void): Promise<void> {
    for await (const outcome of this.requireConnection().watch({ signal, pollIntervalMs: 1_500, onStatus })) {
      const change = unwrapConnectOutcome(outcome);
      if (change.type.startsWith("mdbase.record.") || change.type === "mdbase.type.changed") onChange(change);
    }
  }

  private activeConnection(): MdbaseConnection<NoteFrontmatter> | null {
    const snapshot = this.session.getSnapshot();
    return snapshot.status === "ready" ? snapshot.connection : null;
  }

  private readySummary(): ConnectionSummary | null {
    const snapshot = this.sessionSnapshot();
    return snapshot.status === "ready" ? snapshot.connection : null;
  }

  private requireConnection(): MdbaseConnection<NoteFrontmatter> {
    const connection = this.activeConnection();
    if (!connection) throw new Error("Choose a collection before editing notes.");
    return connection;
  }
}

function summarizeSession(snapshot: MdbaseSessionSnapshot<NoteFrontmatter>): CollectionSessionSnapshot {
  const connections = snapshot.connections.map(summarizeConnection);
  if (snapshot.status === "unselected") return { status: "unselected", connections };
  if (snapshot.status === "unavailable") {
    return {
      status: "unavailable",
      collectionId: snapshot.collectionId,
      reason: snapshot.reason,
      connections
    };
  }
  return {
    status: "ready",
    connection: {
      ...summarizeConnection(snapshot.info),
      missingOperations: snapshot.access.missingOperations
    },
    connections
  };
}

function summarizeConnection(connection: MdbaseConnectionInfo): ConnectionSummary {
  return {
    collectionId: connection.collectionId,
    displayName: connection.displayName,
    operations: connection.operations,
    route: connection.route,
    directAccess: connection.directAccess
  };
}

function uniquePaths(values: Array<{ path: string }> | undefined): string[] {
  return [...new Set(values?.map((value) => value.path) ?? [])];
}

function mutationKey(from: string, to: string, revision: string): string {
  return JSON.stringify([from, to, revision]);
}

function completeSummary(record: QueryRecord<NoteFrontmatter>): NoteSummary {
  if (!record.frontmatter || !record.effective_frontmatter) {
    throw new Error(
      `Query result ${record.path} did not include both frontmatter projections.`
    );
  }
  return {
    ...record,
    frontmatter: record.frontmatter,
    effective_frontmatter: record.effective_frontmatter
  };
}

export function gatewayError(error: unknown): string {
  if (error instanceof ConnectOutcomeError) {
    if (error.problem.code === "connector_offline") return "The computer holding this collection is offline.";
    if (error.problem.recovery === "reauthorize") {
      return "This collection needs authorization again. Choose the collection to continue.";
    }
  }
  if (error instanceof MdbaseConnectError) {
    if (error.code === "connector_offline") return "The computer holding this collection is offline.";
    if (error.requiresAuthorization) {
      return "This collection needs authorization again. Choose the collection to continue.";
    }
  }
  if (error instanceof Error) return error.message;
  return "The collection could not be reached.";
}

function operationOutcomeUnknown(error: unknown): boolean {
  return error instanceof ConnectOutcomeError && error.problem.operation_outcome === "unknown";
}

export type { QueryResult };
