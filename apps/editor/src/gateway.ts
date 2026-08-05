import {
  MdbaseBrowserSelection,
  MdbaseConnect,
  MdbaseConnectError,
  type ConnectOutcome,
  type CollectionDescription,
  type MdbaseConnection,
  type MdbaseConnectionInfo,
  type ApplicationCapabilityId,
  type MdbaseApplicationSession,
  type MdbaseApplicationSessionSnapshot,
  type JsonObject,
  type MdbaseDiagnostic,
  type QueryRecord,
  type QueryResult,
  type TypePackAssessment,
  type TypePackProvision
} from "@mdbase-dev/connect";
import { persistedBody, titlePatch } from "./note";
import type {
  CollectionGateway,
  CollectionAuthorizationTarget,
  CollectionAuthorizationOptions,
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
  TypePackApplyResult
} from "./model";

export const CORE_CAPABILITIES: ApplicationCapabilityId[] = [
  "collection.inspect",
  "records.watch",
  "records.read",
  "records.query",
  "records.validate",
  "records.create",
  "records.update",
  "records.delete",
  "records.rename"
];

export const TYPE_DEFINITION_CAPABILITIES: ApplicationCapabilityId[] = [
  "definitions.read",
  "definitions.create",
  "definitions.update"
];

export function missingCoreCapabilities(connection: ConnectionSummary | null): string[] {
  return connection?.missingCapabilities?.filter((capability) =>
    CORE_CAPABILITIES.includes(capability as ApplicationCapabilityId)
  ) ?? [];
}

export function missingTypeCapabilities(connection: ConnectionSummary | null): string[] {
  return connection?.missingCapabilities?.filter((capability) =>
    TYPE_DEFINITION_CAPABILITIES.includes(capability as ApplicationCapabilityId)
  ) ?? [];
}

const FIRST_PAGE_SIZE = 200;
const PAGE_SIZE = 1_000;

export class ConnectCollectionGateway implements CollectionGateway {
  private readonly session: MdbaseApplicationSession<NoteFrontmatter>;
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
    this.session = connect.application({
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
    return summarizeSession(requireOutcome(await this.session.start()));
  }

  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void): () => void {
    const publish = () => listener(this.sessionSnapshot());
    const stop = this.session.subscribe(publish);
    publish();
    return stop;
  }

  selectConnection(collectionId: string): ConnectionSummary {
    requireOutcome(this.session.select(collectionId, { history: "replace" }));
    const snapshot = this.sessionSnapshot();
    if (snapshot.status !== "ready") {
      throw new Error("The selected collection is not ready.");
    }
    return snapshot.connection;
  }

  async checkDirectAccess(): Promise<ConnectionSummary | null> {
    const connection = this.activeConnection();
    if (!connection) return null;
    requireOutcome(await connection.checkDirectAccess());
    return this.readySummary();
  }

  async requestDirectAccess(): Promise<ConnectionSummary | null> {
    const connection = this.activeConnection();
    if (!connection) return null;
    requireOutcome(await connection.requestDirectAccess());
    return this.readySummary();
  }

  async authorize(
    target: CollectionAuthorizationTarget,
    options: CollectionAuthorizationOptions = {}
  ): Promise<void> {
    requireOutcome(await this.session.authorize(target, options));
  }

  forgetConnection(collectionId: string): void {
    this.session.forget(collectionId);
  }

  async describe(): Promise<CollectionDescription> {
    return requireOutcome(await this.requireConnection().describe());
  }

  async list({ signal, onProgress }: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    const notes: NoteSummary[] = [];
    let snapshot: string | undefined;
    for await (const outcome of this.requireConnection().queryPages({
        orderBy: [{ field: "file.mtime", direction: "desc" }],
        includeBody: false,
        frontmatterMode: "both"
      }, { firstPageSize: FIRST_PAGE_SIZE, pageSize: PAGE_SIZE, signal })) {
      const page = requireOutcome(outcome);
      notes.push(...page.results.map(completeSummary));
      snapshot = page.snapshot;
      onProgress?.({
        notes: [...notes],
        snapshot,
        structureComplete: page.complete,
        complete: page.complete,
        contentComplete: notes.length === 0,
        contentLoaded: 0,
        total: page.meta?.totalCount
      });
    }

    return { notes, snapshot };
  }

  async hydrateContent({ snapshot: requestedSnapshot, signal, onProgress }: NoteContentRequest = {}): Promise<NoteIndexResult> {
    const notes: NoteSummary[] = [];
    let snapshot = requestedSnapshot;
    for await (const outcome of this.requireConnection().queryPages({
        orderBy: [{ field: "file.mtime", direction: "desc" }],
        ...(snapshot ? { snapshot } : {}),
        includeBody: true,
        frontmatterMode: "both"
      }, { firstPageSize: FIRST_PAGE_SIZE, pageSize: PAGE_SIZE, signal })) {
      const page = requireOutcome(outcome);
      notes.push(...page.results.map(completeSummary));
      snapshot = page.snapshot;
      onProgress?.({
        notes: [...notes],
        snapshot,
        structureComplete: true,
        complete: page.complete,
        contentComplete: page.complete,
        contentLoaded: notes.length,
        total: page.meta?.totalCount
      });
    }
    return { notes, snapshot };
  }

  async read(path: string): Promise<NoteDocument> {
    return requireOutcome(await this.requireConnection().read({ path, includeDocument: true }));
  }

  async create(input: CreateNoteInput): Promise<NoteDocument> {
    return requireOutcome(await this.requireConnection().create({
      path: input.path,
      ...(input.type ? { type: input.type } : {}),
      frontmatter: input.properties,
      body: input.titleField
        ? input.body
        : persistedBody(input.title, input.body, { kind: "heading" }),
      includeDocument: true
    }));
  }

  async restore(document: NoteDocument): Promise<NoteDocument> {
    return requireOutcome(await this.requireConnection().create({
      path: document.path,
      frontmatter: document.frontmatter,
      body: document.body,
      includeDocument: true
    }));
  }

  async update(input: SaveNoteInput): Promise<NoteDocument> {
    return requireOutcome(await this.requireConnection().update({
      path: input.path,
      patch: titlePatch(input.title, input.source, input.frontmatter),
      body: persistedBody(input.title, input.body, input.source),
      ifRevision: input.revision,
      includeDocument: true
    }));
  }

  async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    return requireOutcome(await this.requireConnection().update({ path, patch, ifRevision: revision, includeDocument: true }));
  }

  async updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> {
    return requireOutcome(await this.requireConnection().update({
      path,
      document,
      ifRevision: revision
    }));
  }

  async preflightRename(from: string, to: string, revision: string): Promise<RenamePreflight> {
    const result = requireOutcome(await this.requireConnection().preflightRename({
      from,
      to,
      ifRevision: revision,
      updateRefs: true
    }));
    this.renamePreflights.set(mutationKey(from, to, revision), result);
    return {
      affectedPaths: uniquePaths(result.referencesAffected),
      warnings: [...new Set(result.warnings?.map((warning) => warning.message) ?? [])],
      operation: result
    };
  }

  async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    const key = mutationKey(from, to, revision);
    let retainPreflight = false;
    try {
      return requireOutcome(await this.requireConnection().renameWithProgress({
        from,
        to,
        ifRevision: revision,
        updateRefs: updateRefs,
        includeDocument: true
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
    const result = requireOutcome(await this.requireConnection().preflightDelete({ path, ifRevision: revision }));
    this.deletePreflights.set(mutationKey(path, "", revision), result);
    return { brokenLinkPaths: uniquePaths(result.brokenLinks), operation: result };
  }

  async delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
    const key = mutationKey(path, "", revision);
    let retainPreflight = false;
    try {
      requireOutcome(await this.requireConnection().deleteWithProgress({
        path,
        ifRevision: revision,
        checkBacklinks: true
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
    if (!response.ok) throw new MdbaseConnectError(response.problem);
    return response.diagnostics;
  }

  async readType(name: string) {
    return requireOutcome(await this.requireConnection().readType({ name }));
  }

  async createType(document: string) {
    return requireOutcome(await this.requireConnection().createType({ document }));
  }

  async updateType(current: import("./model").TypeDocument, document: string) {
    return requireOutcome(await this.requireConnection().updateType({
      path: current.path,
      document,
      ifRevision: current.revision
    }));
  }

  async assessTypePack(
    provision: TypePackProvision,
    adoptResources: Record<string, string> = {}
  ): Promise<TypePackAssessment> {
    const connection = this.requireConnection();
    return requireOutcome(await connection.assessTypePack({
      provision,
      installedBy: "dev.mdbase.editor",
      adoptResources: adoptResources
    }));
  }

  async applyTypePack(
    provision: TypePackProvision,
    assessment: TypePackAssessment,
    adoptResources: Record<string, string> = {}
  ): Promise<TypePackApplyResult> {
    const connection = this.requireConnection();
    return requireOutcome(await connection.applyTypePack({
      provision,
      installedBy: "dev.mdbase.editor",
      adoptResources: adoptResources,
      expectedAssessmentDigest: assessment.assessmentDigest
    }));
  }

  async watch(onChange: (change: import("@mdbase-dev/connect").CollectionChange) => void, signal: AbortSignal, onStatus?: (status: import("@mdbase-dev/connect").WatchStatus) => void): Promise<void> {
    const opened = requireOutcome(await this.requireConnection().watch({
      pollIntervalMs: 1_500,
      lifetimeSignal: signal
    }));
    if (signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      let stop: () => void = () => undefined;
      stop = opened.subscribe(
        (change) => {
          if (change.type.startsWith("mdbase.record.") || change.type === "mdbase.type.changed") onChange(change);
        },
        onStatus,
        (problem) => {
          stop();
          if (signal.aborted) resolve();
          else reject(new MdbaseConnectError(problem));
        }
      );
      signal.addEventListener("abort", () => {
        stop();
        resolve();
      }, { once: true });
    });
  }

  private activeConnection(): MdbaseConnection<NoteFrontmatter> | null {
    return this.session.connection();
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

function summarizeSession(snapshot: MdbaseApplicationSessionSnapshot): CollectionSessionSnapshot {
  const connections = snapshot.connections.map(summarizeConnection);
  if (snapshot.status === "opening" || snapshot.status === "unselected") return { status: "unselected", connections };
  if (snapshot.status === "unavailable") {
    return {
      status: "unavailable",
      collectionId: snapshot.collectionId,
      reason: snapshot.reason,
      connections
    };
  }
  if (snapshot.status === "ready" || snapshot.status === "authorization_required") return {
    status: "ready",
    connection: {
      ...summarizeConnection(snapshot.info),
      missingCapabilities: Object.values(snapshot.capabilities.values)
        .filter((capability) => capability?.state !== "available")
        .map((capability) => capability!.id)
    },
    connections
  };
  return { status: "unselected", connections };
}

function summarizeConnection(connection: MdbaseConnectionInfo): ConnectionSummary {
  return {
    collectionId: connection.collectionId,
    displayName: connection.displayName,
    operations: connection.operations,
    authorityKind: connection.authority.kind,
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
  if (!record.frontmatter || !record.effectiveFrontmatter) {
    throw new Error(
      `Query result ${record.path} did not include both frontmatter projections.`
    );
  }
  return {
    ...record,
    frontmatter: record.frontmatter,
    effectiveFrontmatter: record.effectiveFrontmatter
  };
}

export function gatewayError(error: unknown): string {
  if (error instanceof MdbaseConnectError) {
    if (error.problem.code === "connector_offline") return "The computer holding this collection is offline.";
    if (error.problem.recovery === "reauthorize") {
      return "This collection needs authorization again. Choose the collection to continue.";
    }
  }
  if (error instanceof Error) return error.message;
  return "The collection could not be reached.";
}

function operationOutcomeUnknown(error: unknown): boolean {
  return error instanceof MdbaseConnectError && error.problem.operation_outcome === "unknown";
}

function requireOutcome<Value>(outcome: ConnectOutcome<Value>): Value {
  if (!outcome.ok) throw new MdbaseConnectError(outcome.problem);
  return outcome.value;
}

export type { QueryResult };
