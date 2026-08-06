import type {
  CollectionChange,
  CollectionContractDescriptor,
  CollectionDescription,
  CollectionFileDescriptor,
  CollectionTypeDescriptor,
  CollectionTypeDocument,
  JsonObject,
  MdbaseDiagnostic,
  TypePackAssessment,
  TypePackProvision
} from "@mdbase-dev/connect";
import { parse } from "yaml";
import { persistedBody, titlePatch } from "./note";
import { composeRecordSource, parseRecordSource } from "./record-source";
import type {
  CollectionGateway,
  CollectionFile,
  CollectionAuthorizationTarget,
  CollectionSessionSnapshot,
  ConnectionSummary,
  CreateNoteInput,
  NoteDocument,
  NoteContentRequest,
  NoteIndexRequest,
  NoteIndexResult,
  FileListRequest,
  FileReadRequest,
  FileUploadRequest,
  NoteSummary,
  RenamePreflight,
  DeletePreflight,
  MutationOperationOptions,
  SaveNoteInput,
  TypePackApplyResult
} from "./model";

export class DemoCollectionGateway implements CollectionGateway {
  private notes: NoteDocument[];
  private files: CollectionFile[] = demoFiles();
  private fileContents = new Map<string, Blob>(demoFileContents());
  private sequence = 1;
  private changeCursor = 0;
  private typeSequence = 1;
  private contractDescriptors: CollectionContractDescriptor[] = [];
  private packResources = new Map<string, string>();
  private listeners = new Set<(change?: CollectionChange) => void>();
  private sessionListeners = new Set<(snapshot: CollectionSessionSnapshot) => void>();
  private readonly openingDelay: number;
  private typeDocuments: CollectionTypeDocument[] = [{
    name: "note",
    path: "_types/note.md",
    revision: "demo-type-1",
    document: DEMO_TYPE_SOURCE
  }];

  constructor(count = 240, openingDelay = 0) {
    this.notes = Array.from({ length: Math.max(1, Math.min(count, 50_000)) }, (_, index) => demoNote(index));
    this.openingDelay = Math.max(0, Math.min(openingDelay, 10_000));
  }

  sessionSnapshot(): CollectionSessionSnapshot {
    const connection = this.currentConnection();
    return connection
      ? { status: "ready", connection, connections: [connection] }
      : { status: "unselected", connections: [] };
  }

  async startSession(): Promise<CollectionSessionSnapshot> {
    return this.sessionSnapshot();
  }

  selectConnection(collectionId: string): ConnectionSummary {
    const connection = this.currentConnection();
    if (!connection || connection.collectionId !== collectionId) {
      throw new Error("This demo collection is not available.");
    }
    return connection;
  }

  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void): () => void {
    this.sessionListeners.add(listener);
    listener(this.sessionSnapshot());
    return () => this.sessionListeners.delete(listener);
  }

  async checkDirectAccess(): Promise<ConnectionSummary | null> {
    return this.currentConnection();
  }

  async requestDirectAccess(): Promise<ConnectionSummary | null> {
    return this.currentConnection();
  }

  async authorize(_target: CollectionAuthorizationTarget): Promise<void> {}
  forgetConnection(_collectionId: string): void {}

  async describe(): Promise<CollectionDescription> {
    if (this.openingDelay) await delay(this.openingDelay);
    return {
      protocolVersion: 1,
      collectionId: "00000000-0000-4000-8000-000000000001",
      displayName: "Writing",
      specVersion: "0.3.0",
      operations: ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename", "read_type", "create_type", "update_type", "apply_type_pack"],
      changeCursor: this.sequence,
      types: this.typeDocuments.map((document) => typeDescriptor(document, this.packResources)),
      contracts: clone(this.contractDescriptors),
      configuration: {
        spec_version: "0.3.0",
        settings: { types_folder: "_types", validation: "error" }
      }
    };
  }

  protected currentConnection(): ConnectionSummary | null {
    return { collectionId: "demo", operations: ["all"], missingCapabilities: [], fileActions: ["list", "read", "add", "replace", "move", "delete"] };
  }

  protected emitSessionChange(): void {
    const snapshot = this.sessionSnapshot();
    for (const listener of this.sessionListeners) listener(snapshot);
  }

  async list({ signal, onProgress }: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    await delay(4);
    signal?.throwIfAborted();
    const snapshot = `demo-${this.changeCursor}`;
    const structure = this.notes.map(demoSummary).map(({ body: _body, ...note }) => note);
    const firstStructurePage = structure.slice(0, Math.min(200, structure.length));
    const structureComplete = firstStructurePage.length === structure.length;
    onProgress?.({
      notes: firstStructurePage,
      snapshot,
      structureComplete,
      complete: structureComplete,
      contentComplete: structure.length === 0,
      contentLoaded: 0,
      total: structure.length
    });
    if (!structureComplete) {
      await delay(4);
      signal?.throwIfAborted();
      onProgress?.({ notes: structure, snapshot, structureComplete: true, complete: true, contentComplete: false, contentLoaded: 0, total: structure.length });
    }
    return { notes: structure, snapshot };
  }

  async hydrateContent({ snapshot: requestedSnapshot, signal, onProgress }: NoteContentRequest = {}): Promise<NoteIndexResult> {
    signal?.throwIfAborted();
    const snapshot = requestedSnapshot ?? `demo-${this.changeCursor}`;
    const notes = this.notes.map(demoSummary);
    const firstPageSize = Math.min(200, notes.length);
    let loaded = firstPageSize;
    while (loaded < notes.length) {
      signal?.throwIfAborted();
      onProgress?.({
        notes: notes.slice(0, loaded),
        snapshot,
        structureComplete: true,
        complete: false,
        contentComplete: false,
        contentLoaded: loaded,
        total: notes.length
      });
      await delay(0);
      loaded = Math.min(notes.length, loaded + 1_000);
    }
    onProgress?.({
      notes,
      snapshot,
      structureComplete: true,
      complete: true,
      contentComplete: true,
      contentLoaded: notes.length,
      total: notes.length
    });
    return { notes, snapshot };
  }

  async read(path: string): Promise<NoteDocument> {
    await delay(5);
    return clone(this.required(path));
  }

  async listFiles({ signal, onProgress }: FileListRequest = {}): Promise<CollectionFile[]> {
    signal?.throwIfAborted();
    const files = clone(this.files);
    onProgress?.({ files, complete: true });
    return files;
  }

  async readFile(file: CollectionFile, { signal, onProgress }: FileReadRequest = {}): Promise<Blob> {
    signal?.throwIfAborted();
    const blob = this.fileContents.get(file.fileId);
    if (!blob) throw new Error("This file no longer exists.");
    onProgress?.({ phase: "downloading", transferredBytes: blob.size, totalBytes: blob.size });
    return blob;
  }

  async uploadFile(path: string, source: import("@mdbase-dev/connect").MdbaseFileSource, { signal, onProgress }: FileUploadRequest = {}): Promise<CollectionFile> {
    signal?.throwIfAborted();
    if (this.files.some((file) => file.path.toLowerCase() === path.toLowerCase())) throw new Error("A file already uses that path.");
    const blob = source instanceof Blob
      ? source
      : new Blob([source instanceof ArrayBuffer ? source : Uint8Array.from(new Uint8Array(source.buffer, source.byteOffset, source.byteLength)).buffer]);
    onProgress?.({ phase: "hashing", transferredBytes: blob.size, totalBytes: blob.size });
    const file: CollectionFileDescriptor = {
      fileId: crypto.randomUUID(),
      path,
      revision: `demo-file-${this.sequence++}`,
      contentDigest: `sha256:${blob.size.toString(16).padStart(64, "0")}`,
      size: blob.size,
      ...(blob.type ? { mediaType: blob.type } : {}),
      mediaClass: mediaClass(path, blob.type),
      modifiedAt: new Date().toISOString()
    };
    this.files.push(file);
    this.fileContents.set(file.fileId, blob);
    onProgress?.({ phase: "uploading", transferredBytes: blob.size, totalBytes: blob.size });
    this.emit("mdbase.file.put", { file: clone(file) as unknown as JsonObject });
    return clone(file);
  }

  async create(input: CreateNoteInput): Promise<NoteDocument> {
    if (this.notes.some((candidate) => candidate.path === input.path)) throw new Error("A note already uses that path.");
    const note = demoDocument(input.path, input.title, "", this.sequence++);
    note.frontmatter = { ...input.properties, ...(input.type ? { type: input.type } : {}) };
    note.effectiveFrontmatter = structuredClone(note.frontmatter);
    note.types = input.type ? [input.type] : [];
    note.body = input.titleField
      ? input.body
      : persistedBody(input.title, input.body, { kind: "heading" });
    note.document = composeRecordSource(note.frontmatter, note.body ?? "");
    note.file = {
      ...note.file!,
      size: new TextEncoder().encode(note.document).byteLength,
      tags: demoTags(note.frontmatter, note.body),
      links: demoLinks(note.body),
      embeds: demoEmbeds(note.body)
    };
    this.notes.unshift(note);
    this.emit("mdbase.record.created", { path: note.path, types: note.types });
    return clone(note);
  }

  async restore(document: NoteDocument): Promise<NoteDocument> {
    if (this.notes.some((candidate) => candidate.path === document.path)) {
      throw new Error("A note already uses that path.");
    }
    const restored = clone(document);
    restored.revision = `demo-${this.sequence++}`;
    restored.document ??= composeRecordSource(restored.frontmatter, restored.body ?? "");
    this.notes.unshift(restored);
    this.emit("mdbase.record.created", { path: restored.path, types: restored.types });
    return clone(restored);
  }

  async update(input: SaveNoteInput): Promise<NoteDocument> {
    const note = this.required(input.path);
    this.assertRevision(note, input.revision);
    note.body = persistedBody(input.title, input.body, input.source);
    note.frontmatter = { ...note.frontmatter, ...titlePatch(input.title, input.source, input.frontmatter) };
    note.effectiveFrontmatter = {
      ...note.effectiveFrontmatter,
      ...titlePatch(input.title, input.source, input.frontmatter)
    };
    note.document = composeRecordSource(note.frontmatter, note.body ?? "");
    this.bump(note);
    return clone(note);
  }

  async updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> {
    const note = this.required(path);
    this.assertRevision(note, revision);
    const parsed = parseRecordSource(document);
    note.document = document;
    note.frontmatter = parsed.frontmatter;
    note.effectiveFrontmatter = structuredClone(parsed.frontmatter);
    note.body = parsed.body;
    this.bump(note);
    return clone(note);
  }

  async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    const note = this.required(path);
    this.assertRevision(note, revision);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete note.frontmatter[key];
        delete note.effectiveFrontmatter[key];
      } else {
        note.frontmatter[key] = value;
        note.effectiveFrontmatter[key] = value;
      }
    }
    note.document = composeRecordSource(note.frontmatter, note.body ?? "");
    this.bump(note);
    return clone(note);
  }

  async preflightRename(from: string, to: string, revision: string): Promise<RenamePreflight> {
    const note = this.required(from);
    this.assertRevision(note, revision);
    if (this.notes.some((candidate) => candidate.path === to)) throw new Error("A note already uses that path.");
    const affectedPaths = this.referenceImpacts(from, to);
    return {
      affectedPaths,
      warnings: [],
      operation: {
        from,
        to,
        dryRun: true,
        wouldRename: true,
        referencesAffected: affectedPaths.map((path) => ({ path, location: "body" }))
      }
    };
  }

  async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    const note = this.required(from);
    this.assertRevision(note, revision);
    if (this.notes.some((candidate) => candidate.path === to)) throw new Error("A note already uses that path.");
    const affectedRecords = updateRefs ? this.referenceImpacts(from, to).length : 0;
    options.onProgress?.({
      operation: "rename",
      state: "applying",
      elapsedMs: 0,
      cancellable: false,
      resumed: false,
      completedUnits: 0,
      estimate: { affectedRecords, totalUnits: affectedRecords + 1, warnings: 0 }
    });
    note.path = to;
    note.file = { ...note.file!, name: to.split("/").at(-1)!, folder: to.split("/").slice(0, -1).join("/") };
    if (updateRefs) this.updateReferences(from, to);
    this.bump(note, "mdbase.record.renamed", { from, to, types: note.types });
    options.onProgress?.({
      operation: "rename",
      state: "completed",
      elapsedMs: 0,
      cancellable: false,
      resumed: false,
      completedUnits: affectedRecords + 1,
      estimate: { affectedRecords, totalUnits: affectedRecords + 1, warnings: 0 }
    });
    return clone(note);
  }

  async preflightDelete(path: string, revision: string): Promise<DeletePreflight> {
    const note = this.required(path);
    this.assertRevision(note, revision);
    const brokenLinkPaths = this.referenceImpacts(path, "__mdbase_deleted_preview__.md");
    return {
      brokenLinkPaths,
      operation: {
        path,
        deleted: false,
        dryRun: true,
        wouldDelete: true,
        brokenLinks: brokenLinkPaths.map((brokenPath) => ({ path: brokenPath }))
      }
    };
  }

  async delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
    const note = this.required(path);
    this.assertRevision(note, revision);
    options.onProgress?.({
      operation: "delete",
      state: "applying",
      elapsedMs: 0,
      cancellable: false,
      resumed: false,
      completedUnits: 0,
      estimate: { affectedRecords: 0, totalUnits: 1, warnings: 0 }
    });
    this.notes = this.notes.filter((candidate) => candidate.path !== path);
    this.emit("mdbase.record.deleted", { path, previous_types: note.types });
    options.onProgress?.({
      operation: "delete",
      state: "completed",
      elapsedMs: 0,
      cancellable: false,
      resumed: false,
      completedUnits: 1,
      estimate: { affectedRecords: 0, totalUnits: 1, warnings: 0 }
    });
  }

  async validate(): Promise<MdbaseDiagnostic[]> {
    return [];
  }

  async readType(name: string): Promise<CollectionTypeDocument> {
    const document = this.typeDocuments.find((candidate) => candidate.name === name);
    if (!document) throw new Error(`Type “${name}” no longer exists.`);
    return clone(document);
  }

  async createType(source: string): Promise<CollectionTypeDocument> {
    const document = typeDocument(source, undefined, `demo-type-${++this.typeSequence}`);
    if (this.typeDocuments.some((candidate) => candidate.name === document.name || candidate.path === document.path)) {
      throw new Error(`Type “${document.name}” already exists.`);
    }
    this.typeDocuments.push(document);
    this.emit("mdbase.type.changed", { name: document.name, path: document.path, revision: document.revision });
    return clone(document);
  }

  async updateType(current: CollectionTypeDocument, source: string): Promise<CollectionTypeDocument> {
    const index = this.typeDocuments.findIndex((candidate) => candidate.path === current.path);
    if (index < 0) throw new Error(`Type “${current.name}” no longer exists.`);
    if (this.typeDocuments[index].revision !== current.revision) {
      throw new Error("This type changed elsewhere. Reload it before saving.");
    }
    const next = typeDocument(source, current.path, `demo-type-${++this.typeSequence}`);
    if (this.typeDocuments.some((candidate, candidateIndex) => candidateIndex !== index && candidate.name === next.name)) {
      throw new Error(`Type “${next.name}” already exists.`);
    }
    this.typeDocuments[index] = next;
    this.emit("mdbase.type.changed", { name: next.name, path: next.path, revision: next.revision });
    return clone(next);
  }

  async assessTypePack(
    provision: TypePackProvision,
    _adoptResources: Record<string, string> = {}
  ): Promise<TypePackAssessment> {
    const sources = new Map(provision.resources.map((resource) => [resource.source, resource.document]));
    const resources = provision.manifest.resources.map((definition) => {
      const document = sources.get(definition.source);
      if (document === undefined) throw new Error(`Type pack resource “${definition.source}” is missing.`);
      const existing = this.packResources.get(definition.target);
      return {
        ...definition,
        action: existing === undefined
          ? "create" as const
          : existing === document
            ? "unchanged" as const
            : "conflict" as const,
        ...(existing !== undefined && existing !== document
          ? { reason: `${definition.target} already exists with different content.` }
          : {})
      };
    });
    const packDigest = provision.manifest.resources[0]?.digest ?? `sha256:${"0".repeat(64)}`;
    const desired = {
      id: provision.manifest.id,
      version: provision.manifest.version,
      digest: packDigest,
      installedBy: "dev.mdbase.editor.demo",
      resources: provision.manifest.resources.map(({ kind, mode, source, target, digest }) => ({
        kind, mode, source, target, digest
      }))
    };
    const conflict = resources.some(({ action }) => action === "conflict");
    return {
      status: conflict ? "conflict" : resources.every(({ action }) => action === "unchanged") ? "current" : "install",
      applicable: !conflict,
      assessmentDigest: packDigest,
      desired,
      resources,
      lock: { target: "mdbase.lock.yaml", action: "update", digest: packDigest },
      contractSetups: { choices: [], resources: [] }
    };
  }

  async applyTypePack(
    provision: TypePackProvision,
    assessment: TypePackAssessment,
    _adoptResources: Record<string, string> = {}
  ): Promise<TypePackApplyResult> {
    const currentAssessment = await this.assessTypePack(provision);
    if (currentAssessment.assessmentDigest !== assessment.assessmentDigest) {
      throw new Error("The type-pack assessment is stale. Review it again.");
    }
    if (!currentAssessment.applicable) {
      throw new Error(currentAssessment.resources.find(({ action }) => action === "conflict")?.reason
        ?? "This type pack conflicts with collection changes.");
    }
    const sources = new Map(provision.resources.map((resource) => [resource.source, resource.document]));
    const planned = provision.manifest.resources.map((resource) => {
      const document = sources.get(resource.source);
      if (document === undefined) throw new Error(`Type pack resource “${resource.source}” is missing.`);
      const existing = this.packResources.get(resource.target);
      if (existing !== undefined && existing !== document) {
        throw new Error(`Type-pack target ${resource.target} already exists with different content.`);
      }
      return {
        definition: resource,
        document,
        action: existing === document ? "unchanged" as const : "create" as const
      };
    });
    if (planned.length !== sources.size) throw new Error("The type pack contains undeclared resources.");

    const typePlans = planned.filter(({ definition }) => definition.kind === "type")
      .map(({ definition, document }) => ({
        definition,
        document: typeDocument(document, definition.target, `demo-type-${++this.typeSequence}`)
      }));
    for (const plan of typePlans) {
      const existing = this.typeDocuments.find((candidate) => candidate.path === plan.document.path);
      if (existing && existing.document !== plan.document.document) {
        throw new Error(`Type “${plan.document.name}” already exists.`);
      }
    }
    const contractPlans = planned.filter(({ definition }) => definition.kind === "contract")
      .map(({ definition, document }) => demoContractDescriptor(
        definition.target,
        definition.digest,
        document,
        planned,
        typePlans
      ));

    for (const { definition, document } of planned) {
      this.packResources.set(definition.target, document);
    }
    for (const plan of typePlans) {
      if (!this.typeDocuments.some((candidate) => candidate.path === plan.document.path)) {
        this.typeDocuments.push(plan.document);
        this.emit("mdbase.type.changed", {
          name: plan.document.name,
          path: plan.document.path,
          revision: plan.document.revision
        });
      }
    }
    for (const contract of contractPlans) {
      const index = this.contractDescriptors.findIndex((candidate) =>
        candidate.id === contract.id && candidate.version === contract.version);
      if (index < 0) this.contractDescriptors.push(contract);
      else this.contractDescriptors[index] = contract;
    }
    const packDigest = provision.manifest.resources[0]?.digest ?? `sha256:${"0".repeat(64)}`;
    const receipt = {
      id: provision.manifest.id,
      version: provision.manifest.version,
      digest: packDigest,
      installedBy: "dev.mdbase.editor.demo",
      resources: provision.manifest.resources.map(({ kind, mode, source, target, digest }) => ({
        kind,
        mode,
        source,
        target,
        digest
      }))
    };
    return {
      status: planned.every(({ action }) => action === "unchanged") ? "current" : "install",
      applicable: true,
      assessmentDigest: packDigest,
      desired: receipt,
      resources: planned.map(({ definition, action }) => ({
        kind: definition.kind,
        mode: definition.mode,
        source: definition.source,
        target: definition.target,
        action,
        digest: definition.digest
      })),
      lock: {
        target: "mdbase.lock.yaml",
        action: "update",
        digest: packDigest
      },
      contractSetups: { choices: [], resources: [] },
      receipt,
      cleanupDeferred: false
    };
  }

  async watch(onChange: (change?: import("@mdbase-dev/connect").CollectionChange) => void, signal: AbortSignal, onStatus?: (status: import("@mdbase-dev/connect").WatchStatus) => void): Promise<void> {
    onStatus?.({ state: "connecting" });
    onStatus?.({ state: "connected", cursor: this.sequence, recovered: false });
    this.listeners.add(onChange);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    this.listeners.delete(onChange);
  }

  private required(path: string): NoteDocument {
    const note = this.notes.find((candidate) => candidate.path === path);
    if (!note) throw new Error("This note no longer exists.");
    return note;
  }

  private assertRevision(note: NoteDocument, revision: string) {
    if (note.revision !== revision) throw new Error("This note changed elsewhere. Reload it before saving.");
  }

  private bump(
    note: NoteDocument,
    changeType = "mdbase.record.modified",
    payload: JsonObject = { path: note.path, types: note.types }
  ) {
    note.revision = `demo-${this.sequence++}`;
    note.file = {
      ...note.file!,
      mtime: new Date().toISOString(),
      tags: demoTags(note.frontmatter, note.body ?? ""),
      links: demoLinks(note.body ?? ""),
      embeds: demoEmbeds(note.body ?? "")
    };
    this.emit(changeType, payload);
  }

  private emit(type: string, payload: JsonObject) {
    const change: CollectionChange = {
      cursor: ++this.changeCursor,
      type,
      occurredAt: new Date().toISOString(),
      payload
    };
    for (const listener of this.listeners) listener(change);
  }

  private updateReferences(from: string, to: string) {
    const fromWithoutExtension = from.replace(/\.md$/i, "");
    const toWithoutExtension = to.replace(/\.md$/i, "");
    for (const note of this.notes) {
      if (!note.body) continue;
      const nextBody = note.body
        .replaceAll(`[[${fromWithoutExtension}`, `[[${toWithoutExtension}`)
        .replaceAll(`](${from}`, `](${to}`);
      if (nextBody === note.body) continue;
      note.body = nextBody;
      this.bump(note);
    }
  }

  private referenceImpacts(from: string, to: string): string[] {
    const fromWithoutExtension = from.replace(/\.md$/i, "");
    const toWithoutExtension = to.replace(/\.md$/i, "");
    return this.notes.flatMap((note) => {
      if (!note.body || note.path === from) return [];
      const nextBody = note.body
        .replaceAll(`[[${fromWithoutExtension}`, `[[${toWithoutExtension}`)
        .replaceAll(`](${from}`, `](${to}`);
      return nextBody === note.body ? [] : [note.path];
    });
  }
}

const DEMO_TYPE_SOURCE = `---
kind: mdbase.type
name: note
version: 1
description: A general note with optional tags.
match:
  path_glob: Notes/**/*.md
collection:
  display:
    icon: notebook
    name_field: title
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type:
        const: note
      title:
        type: string
        minLength: 1
      tags:
        type: array
        items:
          type: string
---
`;

function typeDocument(source: string, path: string | undefined, revision: string): CollectionTypeDocument {
  const definition = typeDefinition(source);
  const name = typeof definition.name === "string" ? definition.name.trim() : "";
  if (!name) throw new Error("A type definition needs a name.");
  return { name, path: path ?? `_types/${name}.md`, revision, document: source };
}

function typeDescriptor(
  document: CollectionTypeDocument,
  resources: ReadonlyMap<string, string> = new Map()
): CollectionTypeDescriptor {
  const definition = typeDefinition(document.document);
  const schema = resolvedSchema(definition.schema, document.path, resources);
  return {
    name: document.name,
    path: document.path,
    ...(typeof definition.version === "number" ? { version: definition.version } : {}),
    ...(typeof definition.description === "string" ? { description: definition.description } : {}),
    definition,
    schema,
    ...(isObject(definition.collection) ? { collection: definition.collection } : {}),
    extensions: {}
  };
}

function demoContractDescriptor(
  path: string,
  digest: string,
  source: string,
  resources: Array<{
    definition: TypePackProvision["manifest"]["resources"][number];
    document: string;
  }>,
  types: Array<{
    definition: TypePackProvision["manifest"]["resources"][number];
    document: CollectionTypeDocument;
  }>
): CollectionContractDescriptor {
  const definition = frontmatterDefinition(source, "mdbase.contract");
  const id = typeof definition.id === "string" ? definition.id : "";
  const version = typeof definition.version === "string" ? definition.version : "";
  if (!id || !version) throw new Error("Contract resources need an id and version.");
  const documents = new Map(resources.map(({ definition: resource, document }) => [
    resource.target,
    document
  ]));
  const implementations = types.flatMap(({ definition: resource, document }) => {
    const type = typeDefinition(document.document);
    if (!Array.isArray(type.implements)) return [];
    return type.implements.flatMap((candidate) => {
      if (!isObject(candidate) || candidate.contract !== id || candidate.version !== version) return [];
      const fields = isObject(candidate.fields)
        ? Object.fromEntries(Object.entries(candidate.fields)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : {};
      return [{
        typeName: document.name,
        typeVersion: typeof type.version === "number" ? type.version : 1,
        typePath: document.path,
        digest: resource.digest,
        fields,
        ...(isObject(candidate.binding) ? { binding: candidate.binding } : {})
      }];
    });
  });
  return {
    contractType: "record",
    id,
    version,
    digest,
    schema: resolvedSchema(definition.record_schema, path, documents),
    ...(isObject(definition.binding_schema)
      ? { bindingSchema: resolvedSchema(definition.binding_schema, path, documents) }
      : {}),
    implementations
  };
}

function typeDefinition(source: string): JsonObject {
  return frontmatterDefinition(source, "mdbase.type");
}

function frontmatterDefinition(source: string, kind: string): JsonObject {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("Pack resources need YAML frontmatter between --- markers.");
  const value = parse(match[1]);
  if (!isObject(value) || value.kind !== kind) {
    throw new Error(`Pack resources must declare kind: ${kind}.`);
  }
  return value;
}

function resolvedSchema(
  value: unknown,
  documentPath: string,
  resources: ReadonlyMap<string, string>
): JsonObject {
  if (!isObject(value)) return {};
  if (isObject(value.value)) return value.value;
  if (typeof value.ref !== "string") return {};
  const target = resolvePackReference(documentPath, value.ref);
  const document = resources.get(target);
  if (!document) throw new Error(`Referenced schema “${target}” is missing.`);
  const parsed = JSON.parse(document);
  if (!isObject(parsed)) throw new Error(`Referenced schema “${target}” must be an object.`);
  return parsed;
}

function resolvePackReference(from: string, reference: string): string {
  const base = new URL(from, "https://collection.invalid/");
  return new URL(reference, base).pathname.slice(1);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function demoNote(index: number): NoteDocument {
  const folders = ["Notes", "Journal", "Projects", "Reading", "Archive"];
  const subjects = [
    "The shape of useful tools",
    "Garden notes",
    "A quiet interface",
    "Reading list",
    "Ideas for Sunday",
    "Release notes",
    "Questions worth keeping"
  ];
  const title = index === 0 ? "The shape of useful tools" : `${subjects[index % subjects.length]} ${index + 1}`;
  const folder = folders[index % folders.length];
  const path = `${folder}/${slug(title)}.md`;
  const paragraphs = index === 0
    ? "Good tools leave room around the work. They keep the durable thing visible, make consequential choices legible, and then get out of the way.\n\n![[Assets/frontmatter.svg|A durable piece of frontmatter]]\n\nThis note is ordinary Markdown. It can be edited here, from the filesystem, or by another application with permission."
    : index === 1
      ? "A generated note used to test a large collection.\n\nThis grew from [[Notes/the-shape-of-useful-tools|The shape of useful tools]]."
      : `A generated note used to test a large collection.\n\nRecord ${index + 1} remains lightweight while the list is virtualized.`;
  return demoDocument(path, title, paragraphs, index + 1);
}

function demoDocument(path: string, title: string, body: string, sequence: number): NoteDocument {
  const persisted = `# ${title}\n\n${body}`.trimEnd() + "\n";
  const timestamp = new Date(Date.now() - sequence * 3_600_000).toISOString();
  const frontmatter = sequence % 3 === 0 ? { tags: ["notes", "ideas"] } : {};
  return {
    path,
    frontmatter,
    effectiveFrontmatter: structuredClone(frontmatter),
    body: persisted,
    document: composeRecordSource(frontmatter, persisted),
    types: sequence % 4 === 0 ? ["note"] : [],
    revision: `demo-${sequence}`,
    file: {
      name: path.split("/").at(-1)!,
      folder: path.split("/").slice(0, -1).join("/"),
      size: new TextEncoder().encode(persisted).byteLength,
      mtime: timestamp,
      tags: demoTags(frontmatter, persisted),
      links: demoLinks(persisted),
      embeds: demoEmbeds(persisted)
    }
  };
}

function demoSummary(document: NoteDocument): NoteSummary {
  const { revision: _revision, ...summary } = document;
  return {
    ...summary,
    file: { ...document.file, path: document.path }
  };
}

function demoTags(frontmatter: JsonObject, body: string): string[] {
  const persisted = Array.isArray(frontmatter.tags) ? frontmatter.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const inline = [...body.matchAll(/(?:^|\s)#([A-Za-z0-9_/-]+)/gm)].map((match) => match[1]);
  return [...new Set([...persisted, ...inline])];
}

function demoLinks(body: string): string[] {
  const wikilinks = [...body.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((match) => match[1].trim());
  const markdown = [...body.matchAll(/(?<!!)\[[^\]]+\]\((?!https?:\/\/)([^)#]+)(?:#[^)]*)?\)/g)].map((match) => match[1].trim());
  return [...new Set([...wikilinks, ...markdown])];
}

function demoEmbeds(body: string): string[] {
  const wikilinks = [...body.matchAll(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((match) => match[1].trim());
  const markdown = [...body.matchAll(/!\[[^\]]*\]\((?!https?:\/\/)([^)#]+)(?:#[^)]*)?\)/g)].map((match) => match[1].trim());
  return [...new Set([...wikilinks, ...markdown])];
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function demoFiles(): CollectionFile[] {
  return [
    {
      fileId: "00000000-0000-4000-8000-000000000101",
      path: "Assets/frontmatter.svg",
      revision: "demo-file-1",
      contentDigest: `sha256:${"1".padStart(64, "0")}`,
      size: FRONTMATTER_SVG.length,
      mediaType: "image/svg+xml",
      mediaClass: "image",
      modifiedAt: "2020-08-07T00:00:00Z"
    },
    {
      fileId: "00000000-0000-4000-8000-000000000102",
      path: "Documents/interface-notes.pdf",
      revision: "demo-file-2",
      contentDigest: `sha256:${"2".padStart(64, "0")}`,
      size: DEMO_PDF.length,
      mediaType: "application/pdf",
      mediaClass: "pdf",
      modifiedAt: "2020-08-06T00:00:00Z"
    }
  ];
}

function demoFileContents(): Array<[string, Blob]> {
  return [
    ["00000000-0000-4000-8000-000000000101", new Blob([FRONTMATTER_SVG], { type: "image/svg+xml" })],
    ["00000000-0000-4000-8000-000000000102", new Blob([DEMO_PDF], { type: "application/pdf" })]
  ];
}

function mediaClass(path: string, mediaType: string): CollectionFile["mediaClass"] {
  if (mediaType.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|svg)$/iu.test(path)) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/pdf" || /\.pdf$/iu.test(path)) return "pdf";
  return "other";
}

const FRONTMATTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f5f8fb"/><g fill="none" stroke="#243444" stroke-width="16" stroke-linecap="square"><path d="M230 122h500M230 418h500"/><path d="M230 220h135M230 320h135"/></g><g fill="none" stroke-width="16" stroke-linecap="square"><path d="M415 220h315" stroke="#2878a6"/><path d="M415 320h315" stroke="#243444"/></g></svg>`;
const DEMO_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";
