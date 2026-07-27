import type {
  CollectionChange,
  CollectionDescription,
  CollectionTypeDescriptor,
  CollectionTypeDocument,
  JsonObject,
  MdbaseDiagnostic
} from "@mdbase/connect";
import { parse } from "yaml";
import { persistedBody, titlePatch } from "./note";
import { composeRecordSource, parseRecordSource } from "./record-source";
import type {
  CollectionGateway,
  ConnectionSummary,
  CreateNoteInput,
  NoteDocument,
  NoteListProgress,
  NoteSummary,
  RenamePreflight,
  DeletePreflight,
  MutationOperationOptions,
  SaveNoteInput
} from "./model";

export class DemoCollectionGateway implements CollectionGateway {
  private notes: NoteDocument[];
  private sequence = 1;
  private changeCursor = 0;
  private typeSequence = 1;
  private listeners = new Set<(change?: CollectionChange) => void>();
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

  connection(): ConnectionSummary | null {
    return { collectionId: "demo", operations: ["all"], missingOperations: [] };
  }

  connections(): ConnectionSummary[] {
    const connection = this.connection();
    return connection ? [connection] : [];
  }

  selectConnection(_collectionId: string): void {}

  onConnectionChange(listener: (connection: ConnectionSummary | null) => void): () => void {
    listener(this.connection());
    return () => undefined;
  }

  async authorize(): Promise<void> {}
  async authorizeNewCollection(): Promise<void> {}
  async completeAuthorization(): Promise<void> {}
  disconnect(): void {}

  async describe(): Promise<CollectionDescription> {
    if (this.openingDelay) await delay(this.openingDelay);
    return {
      protocol_version: 1,
      collection_id: "00000000-0000-4000-8000-000000000001",
      display_name: "Writing",
      spec_version: "0.3.0",
      operations: ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename", "read_type", "create_type", "update_type"],
      change_cursor: this.sequence,
      types: this.typeDocuments.map(typeDescriptor),
      contracts: [],
      configuration: {
        spec_version: "0.3.0",
        settings: { types_folder: "_types", validation: "error" }
      }
    };
  }

  async list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    await delay(4);
    const notes = this.notes.map(demoSummary);
    const structure = notes.map(({ body: _body, ...note }) => note);
    const firstStructurePage = structure.slice(0, Math.min(200, structure.length));
    const structureComplete = firstStructurePage.length === structure.length;
    onProgress?.({
      notes: firstStructurePage,
      structureComplete,
      complete: structureComplete && structure.length === 0,
      contentComplete: structure.length === 0,
      contentLoaded: 0,
      total: structure.length
    });
    if (!structureComplete) {
      await delay(4);
      onProgress?.({ notes: structure, structureComplete: true, complete: false, contentComplete: false, contentLoaded: 0, total: structure.length });
    }
    if (notes.length) {
      await delay(4);
      const firstContentPage = notes.slice(0, Math.min(200, notes.length));
      const hydrated = [...structure];
      for (let index = 0; index < firstContentPage.length; index += 1) hydrated[index] = firstContentPage[index];
      onProgress?.({
        notes: hydrated,
        structureComplete: true,
        complete: firstContentPage.length === notes.length,
        contentComplete: firstContentPage.length === notes.length,
        contentLoaded: firstContentPage.length,
        total: notes.length
      });
      if (firstContentPage.length !== notes.length) {
        await delay(4);
        onProgress?.({ notes, structureComplete: true, complete: true, contentComplete: true, contentLoaded: notes.length, total: notes.length });
      }
    }
    return notes;
  }

  async hydrateContent(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    const notes = this.notes.map(demoSummary);
    onProgress?.({
      notes,
      structureComplete: true,
      complete: true,
      contentComplete: true,
      contentLoaded: notes.length,
      total: notes.length
    });
    return notes;
  }

  async read(path: string): Promise<NoteDocument> {
    await delay(5);
    return clone(this.required(path));
  }

  async create(input: CreateNoteInput): Promise<NoteDocument> {
    if (this.notes.some((candidate) => candidate.path === input.path)) throw new Error("A note already uses that path.");
    const note = demoDocument(input.path, input.title, "", this.sequence++);
    note.frontmatter = { ...input.properties, ...(input.type ? { type: input.type } : {}) };
    note.effective_frontmatter = structuredClone(note.frontmatter);
    note.types = input.type ? [input.type] : [];
    if (input.titleField) note.body = "";
    note.document = composeRecordSource(note.frontmatter, note.body);
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
    restored.document ??= composeRecordSource(restored.frontmatter, restored.body);
    this.notes.unshift(restored);
    this.emit("mdbase.record.created", { path: restored.path, types: restored.types });
    return clone(restored);
  }

  async update(input: SaveNoteInput): Promise<NoteDocument> {
    const note = this.required(input.path);
    this.assertRevision(note, input.revision);
    note.body = persistedBody(input.title, input.body, input.source);
    note.frontmatter = { ...note.frontmatter, ...titlePatch(input.title, input.source) };
    note.effective_frontmatter = {
      ...note.effective_frontmatter,
      ...titlePatch(input.title, input.source)
    };
    note.document = composeRecordSource(note.frontmatter, note.body);
    this.bump(note);
    return clone(note);
  }

  async updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> {
    const note = this.required(path);
    this.assertRevision(note, revision);
    const parsed = parseRecordSource(document);
    note.document = document;
    note.frontmatter = parsed.frontmatter;
    note.effective_frontmatter = structuredClone(parsed.frontmatter);
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
        delete note.effective_frontmatter[key];
      } else {
        note.frontmatter[key] = value;
        note.effective_frontmatter[key] = value;
      }
    }
    note.document = composeRecordSource(note.frontmatter, note.body);
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
        dry_run: true,
        would_rename: true,
        references_affected: affectedPaths.map((path) => ({ path, location: "body" }))
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
        dry_run: true,
        would_delete: true,
        broken_links: brokenLinkPaths.map((brokenPath) => ({ path: brokenPath }))
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

  async watch(onChange: (change?: import("@mdbase/connect").CollectionChange) => void, signal: AbortSignal, onStatus?: (status: import("@mdbase/connect").WatchStatus) => void): Promise<void> {
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
      occurred_at: new Date().toISOString(),
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

function typeDescriptor(document: CollectionTypeDocument): CollectionTypeDescriptor {
  const definition = typeDefinition(document.document);
  const schema = isObject(definition.schema) && isObject(definition.schema.value)
    ? definition.schema.value
    : {};
  return {
    name: document.name,
    path: document.path,
    ...(typeof definition.version === "number" ? { version: definition.version } : {}),
    ...(typeof definition.description === "string" ? { description: definition.description } : {}),
    definition,
    schema,
    extensions: {}
  };
}

function typeDefinition(source: string): JsonObject {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("Type definitions need YAML frontmatter between --- markers.");
  const value = parse(match[1]);
  if (!isObject(value) || value.kind !== "mdbase.type") {
    throw new Error("Type definitions must declare kind: mdbase.type.");
  }
  return value;
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
    ? "Good tools leave room around the work. They keep the durable thing visible, make consequential choices legible, and then get out of the way.\n\nThis note is ordinary Markdown. It can be edited here, from the filesystem, or by another application with permission."
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
    effective_frontmatter: structuredClone(frontmatter),
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
