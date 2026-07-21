import type {
  CollectionDescription,
  JsonObject,
  MdbaseDiagnostic
} from "@mdbase/connect";
import { persistedBody, titlePatch } from "./note";
import type {
  CollectionGateway,
  ConnectionSummary,
  CreateNoteInput,
  NoteDocument,
  NoteListProgress,
  NoteSummary,
  SaveNoteInput
} from "./model";

export class DemoCollectionGateway implements CollectionGateway {
  private notes: NoteDocument[];
  private sequence = 1;
  private listeners = new Set<() => void>();
  private readonly openingDelay: number;

  constructor(count = 240, openingDelay = 0) {
    this.notes = Array.from({ length: Math.max(1, Math.min(count, 50_000)) }, (_, index) => demoNote(index));
    this.openingDelay = Math.max(0, Math.min(openingDelay, 10_000));
  }

  connection(): ConnectionSummary {
    return { collectionId: "demo", operations: ["all"] };
  }

  async authorize(): Promise<void> {}
  async completeAuthorization(): Promise<void> {}
  disconnect(): void {}

  async describe(): Promise<CollectionDescription> {
    if (this.openingDelay) await delay(this.openingDelay);
    return {
      protocol_version: 2,
      collection_id: "00000000-0000-4000-8000-000000000001",
      display_name: "Writing",
      spec_version: "0.3.0",
      operations: ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename"],
      change_cursor: this.sequence,
      types: [{
        name: "note",
        version: 1,
        description: "A general note with optional tags.",
        path: "_types/note.md",
        definition: {
          kind: "mdbase.type",
          name: "note",
          version: 1,
          description: "A general note with optional tags.",
          match: { path_glob: "Notes/**/*.md" },
          schema: {
            dialect: "json-schema-2020-12",
            value: {
              type: "object",
              properties: {
                type: { const: "note" },
                title: { type: "string", minLength: 1 },
                tags: { type: "array", items: { type: "string" } }
              }
            }
          }
        },
        schema: {
          type: "object",
          properties: {
            type: { const: "note" },
            title: { type: "string", minLength: 1 },
            tags: { type: "array", items: { type: "string" } }
          }
        },
        extensions: {}
      }],
      contracts: [],
      configuration: {
        spec_version: "0.3.0",
        settings: { types_folder: "_types", validation: "error" }
      }
    };
  }

  async list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    await delay(4);
    const notes = this.notes
      .map(({ revision: _revision, raw_frontmatter: _raw, ...note }) => note);
    const firstPage = notes.slice(0, Math.min(200, notes.length));
    onProgress?.({ notes: firstPage, complete: firstPage.length === notes.length, total: notes.length });
    if (firstPage.length !== notes.length) {
      await delay(4);
      onProgress?.({ notes, complete: true, total: notes.length });
    }
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
    note.raw_frontmatter = structuredClone(note.frontmatter);
    note.types = input.type ? [input.type] : [];
    if (input.titleField) note.body = "";
    this.notes.unshift(note);
    this.emit();
    return clone(note);
  }

  async update(input: SaveNoteInput): Promise<NoteDocument> {
    const note = this.required(input.path);
    this.assertRevision(note, input.revision);
    note.body = persistedBody(input.title, input.body, input.source);
    note.frontmatter = { ...note.frontmatter, ...titlePatch(input.title, input.source) };
    note.raw_frontmatter = { ...note.raw_frontmatter, ...titlePatch(input.title, input.source) };
    this.bump(note);
    return clone(note);
  }

  async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    const note = this.required(path);
    this.assertRevision(note, revision);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete note.frontmatter[key];
        delete note.raw_frontmatter?.[key];
      } else {
        note.frontmatter[key] = value;
        if (note.raw_frontmatter) note.raw_frontmatter[key] = value;
      }
    }
    this.bump(note);
    return clone(note);
  }

  async rename(from: string, to: string, revision: string): Promise<NoteDocument> {
    const note = this.required(from);
    this.assertRevision(note, revision);
    if (this.notes.some((candidate) => candidate.path === to)) throw new Error("A note already uses that path.");
    note.path = to;
    note.file = { ...note.file!, name: to.split("/").at(-1)!, folder: to.split("/").slice(0, -1).join("/") };
    this.bump(note);
    return clone(note);
  }

  async delete(path: string, revision: string): Promise<void> {
    const note = this.required(path);
    this.assertRevision(note, revision);
    this.notes = this.notes.filter((candidate) => candidate.path !== path);
    this.emit();
  }

  async validate(): Promise<MdbaseDiagnostic[]> {
    return [];
  }

  async watch(onChange: (change?: import("@mdbase/connect").CollectionChange) => void, signal: AbortSignal): Promise<void> {
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

  private bump(note: NoteDocument) {
    note.revision = `demo-${this.sequence++}`;
    note.file = { ...note.file!, mtime: new Date().toISOString() };
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
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
    : `A generated note used to test a large collection.\n\nRecord ${index + 1} remains lightweight while the list is virtualized.`;
  return demoDocument(path, title, paragraphs, index + 1);
}

function demoDocument(path: string, title: string, body: string, sequence: number): NoteDocument {
  const persisted = `# ${title}\n\n${body}`.trimEnd() + "\n";
  const timestamp = new Date(Date.now() - sequence * 3_600_000).toISOString();
  return {
    path,
    frontmatter: sequence % 3 === 0 ? { tags: ["notes", "ideas"] } : {},
    raw_frontmatter: sequence % 3 === 0 ? { tags: ["notes", "ideas"] } : {},
    body: persisted,
    types: sequence % 4 === 0 ? ["note"] : [],
    revision: `demo-${sequence}`,
    file: {
      name: path.split("/").at(-1)!,
      folder: path.split("/").slice(0, -1).join("/"),
      size: new TextEncoder().encode(persisted).byteLength,
      mtime: timestamp,
      tags: sequence % 3 === 0 ? ["notes", "ideas"] : []
    }
  };
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
