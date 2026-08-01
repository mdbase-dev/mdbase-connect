import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import type { EditableNote, NoteDocument, NoteSummary, TitleSource } from "./model";
import {
  fieldReferencePath,
  fieldReferencePatch,
  readFieldReference,
  recordDisplayField
} from "./field-reference";

export function editableNote(
  note: NoteDocument,
  types: CollectionTypeDescriptor[] = []
): EditableNote {
  const field = recordDisplayField(note.types, types, "name_field");
  const body = note.body ?? "";
  if (field && fieldReferencePath(field)) {
    const value = readFieldReference(note.frontmatter, field)
      ?? readFieldReference(note.effective_frontmatter, field);
    return {
      title: typeof value === "string" && value.trim()
        ? value.trim()
        : markdownHeading(body) ?? basename(note.path),
      body,
      source: { kind: "frontmatter", field }
    };
  }

  const heading = body.match(/^#\s+(.+?)(?:\r?\n|$)/);
  if (heading) {
    const content = body.slice(heading[0].length).replace(/^\r?\n/, "");
    return { title: heading[1].trim(), body: content, source: { kind: "heading" } };
  }

  return { title: basename(note.path), body, source: { kind: "heading" } };
}

export function persistedBody(title: string, body: string, source: TitleSource): string {
  if (source.kind === "frontmatter") return body;
  const cleanTitle = title.trim() || "Untitled";
  const cleanBody = body.replace(/^\s*\n/, "");
  return cleanBody ? `# ${cleanTitle}\n\n${cleanBody}` : `# ${cleanTitle}\n`;
}

export function titlePatch(title: string, source: TitleSource, frontmatter: JsonObject = {}): JsonObject {
  return source.kind === "frontmatter"
    ? fieldReferencePatch(frontmatter, source.field, title.trim() || "Untitled")
    : {};
}

export function noteTitle(
  note: Pick<NoteDocument, "path" | "effective_frontmatter" | "types"> & { body?: string },
  types: CollectionTypeDescriptor[] = []
): string {
  const field = recordDisplayField(note.types, types, "name_field");
  const value = readFieldReference(note.effective_frontmatter, field);
  if (typeof value === "string" && value.trim()) return value.trim();
  const heading = markdownHeading(note.body ?? "");
  if (heading) return heading;
  return basename(note.path);
}

export function notePreview(note: NoteSummary, types: CollectionTypeDescriptor[] = []): string {
  const field = recordDisplayField(note.types, types, "description_field");
  const description = readFieldReference(note.effective_frontmatter, field);
  if (typeof description === "string" && description.trim()) return description.trim();
  if (note.types.length) return note.types.join(" · ");
  return folder(note.path) || "Markdown";
}

export function noteTimestamp(note: NoteSummary): string {
  const value = note.file?.mtime;
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export function folder(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

export function basename(path: string): string {
  return path.split("/").at(-1)?.replace(/\.[^.]+$/, "") || "Untitled";
}

function markdownHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+?)(?:\r?\n|$)/)?.[1].trim() || undefined;
}

export interface FolderTreeNode {
  name: string;
  path: string;
  count: number;
  children: FolderTreeNode[];
}

interface MutableFolderTreeNode extends Omit<FolderTreeNode, "children"> {
  children: Map<string, MutableFolderTreeNode>;
}

const facetCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function folderTree(notes: NoteSummary[]): FolderTreeNode[] {
  const roots = new Map<string, MutableFolderTreeNode>();
  for (const note of notes) {
    const directory = folder(note.path);
    if (!directory) continue;
    let siblings = roots;
    let parentPath = "";
    for (const name of directory.split("/").filter(Boolean)) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      let node = siblings.get(name);
      if (!node) {
        node = { name, path, count: 0, children: new Map() };
        siblings.set(name, node);
      }
      node.count += 1;
      parentPath = path;
      siblings = node.children;
    }
  }

  const freeze = (nodes: Map<string, MutableFolderTreeNode>): FolderTreeNode[] =>
    [...nodes.values()]
      .sort((left, right) => facetCollator.compare(left.name, right.name))
      .map((node) => ({
        name: node.name,
        path: node.path,
        count: node.count,
        children: freeze(node.children)
      }));

  return freeze(roots);
}

export function folders(notes: NoteSummary[]): Array<{ name: string; count: number }> {
  return folderTree(notes).map(({ name, count }) => ({ name, count }));
}

export function noteTags(note: NoteSummary): string[] {
  const fileTags = Array.isArray(note.file.tags) ? note.file.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const frontmatterTags = Array.isArray(note.effective_frontmatter.tags)
    ? note.effective_frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
    : typeof note.effective_frontmatter.tags === "string" ? [note.effective_frontmatter.tags] : [];
  return [...new Set([...fileTags, ...frontmatterTags].map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean))];
}

export function tags(notes: NoteSummary[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const tag of noteTags(note)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function types(notes: NoteSummary[], declared: string[] = []): Array<{ name: string; count: number }> {
  const counts = new Map(declared.map((name) => [name, 0]));
  for (const note of notes) {
    for (const type of new Set(note.types)) {
      const count = counts.get(type);
      if (count !== undefined) counts.set(type, count + 1);
    }
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function propertyPatch(before: JsonObject, after: JsonObject): JsonObject {
  const patch: JsonObject = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) patch[key] = null;
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
  }
  return patch;
}

export function safeRenamePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
}
