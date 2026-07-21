import type { JsonObject } from "@mdbase/connect";
import type { EditableNote, NoteDocument, NoteSummary, TitleSource } from "./model";

const preferredTitleFields = ["title", "name", "subject"];

export function editableNote(note: NoteDocument): EditableNote {
  for (const field of preferredTitleFields) {
    const value = note.raw_frontmatter?.[field] ?? note.frontmatter[field];
    if (typeof value === "string" && value.trim()) {
      return { title: value.trim(), body: note.body ?? "", source: { kind: "frontmatter", field } };
    }
  }

  const body = note.body ?? "";
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

export function titlePatch(title: string, source: TitleSource): JsonObject {
  return source.kind === "frontmatter" ? { [source.field]: title.trim() || "Untitled" } : {};
}

export function noteTitle(note: NoteSummary): string {
  for (const field of preferredTitleFields) {
    const value = note.frontmatter[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (note.body) {
    const heading = note.body.match(/^#\s+(.+?)(?:\r?\n|$)/);
    if (heading) return heading[1].trim();
  }
  return basename(note.path);
}

export function notePreview(note: NoteSummary): string {
  const description = ["summary", "description", "status"]
    .map((field) => note.frontmatter[field])
    .find((value) => typeof value === "string" && value.trim());
  if (typeof description === "string") return description.trim();
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

export function folders(notes: NoteSummary[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const name = folder(note.path);
    if (!name) continue;
    const top = name.split("/")[0];
    counts.set(top, (counts.get(top) ?? 0) + 1);
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
