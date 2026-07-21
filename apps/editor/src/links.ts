import type { NoteSummary } from "./model";
import { basename, folder, noteTitle } from "./note";

export interface LinkSuggestion {
  path: string;
  title: string;
}

interface LinkReference {
  target: string;
  format?: string;
  isRelative?: boolean;
}

interface LinkIndex {
  paths: Map<string, NoteSummary>;
  foldedPaths: Map<string, NoteSummary>;
  ids: Map<string, NoteSummary[]>;
  filenames: Map<string, NoteSummary[]>;
}

export function linkSuggestions(notes: NoteSummary[]): LinkSuggestion[] {
  return notes
    .map((note) => ({ path: note.path, title: noteTitle(note) }))
    .sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path));
}

export function backlinksFor(targetPath: string, notes: NoteSummary[]): NoteSummary[] {
  const index = linkIndex(notes);
  return notes
    .filter((note) => referencesFor(note).some((reference) => resolveReference(note.path, reference, index)?.path === targetPath))
    .sort((left, right) => noteTitle(left).localeCompare(noteTitle(right)) || left.path.localeCompare(right.path));
}

export function wikilinkFor(suggestion: LinkSuggestion): string {
  const target = suggestion.path.replace(/\.md$/i, "");
  return basename(suggestion.path).localeCompare(suggestion.title, undefined, { sensitivity: "accent" }) === 0
    ? target
    : `${target}|${suggestion.title}`;
}

function referencesFor(note: NoteSummary): LinkReference[] {
  return [...referenceList(note.file?.links), ...referenceList(note.file?.embeds)];
}

function referenceList(values: unknown): LinkReference[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (typeof value === "string") return value.trim() ? [{ target: value }] : [];
    if (!value || Array.isArray(value) || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const target = [record.target, record.path, record.raw].find((candidate) => typeof candidate === "string" && candidate.trim());
    if (typeof target !== "string") return [];
    return [{
      target,
      format: typeof record.format === "string" ? record.format : undefined,
      isRelative: typeof record.is_relative === "boolean" ? record.is_relative : undefined
    }];
  });
}

function resolveReference(sourcePath: string, reference: LinkReference, index: LinkIndex): NoteSummary | undefined {
  const target = cleanTarget(reference.target);
  if (!target || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) return undefined;
  const sourceFolder = folder(sourcePath);

  if (target.startsWith("/")) return findPath(target.slice(1), index);
  if (reference.isRelative || reference.format === "markdown" || reference.format === "path" || target.startsWith("./") || target.startsWith("../")) {
    return findPath(joinPath(sourceFolder, target), index);
  }
  if (target.includes("/")) {
    return findPath(target, index) ?? findPath(joinPath(sourceFolder, target), index);
  }

  const idMatches = index.ids.get(target) ?? [];
  if (idMatches.length === 1) return idMatches[0];

  const name = target.replace(/\.md$/i, "");
  const filenameMatches = index.filenames.get(name) ?? [];
  return [...filenameMatches].sort((left, right) => {
    const leftSameFolder = folder(left.path) === sourceFolder ? 0 : 1;
    const rightSameFolder = folder(right.path) === sourceFolder ? 0 : 1;
    return leftSameFolder - rightSameFolder || left.path.length - right.path.length || left.path.localeCompare(right.path);
  })[0];
}

function findPath(value: string, index: LinkIndex): NoteSummary | undefined {
  const normalized = normalizePath(value);
  if (!normalized || normalized.startsWith("../")) return undefined;
  const candidates = /\.[^/]+$/.test(normalized) ? [normalized] : [normalized, `${normalized}.md`];
  for (const candidate of candidates) {
    const exact = index.paths.get(candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const folded = index.foldedPaths.get(candidate.toLocaleLowerCase());
    if (folded) return folded;
  }
  return undefined;
}

function linkIndex(notes: NoteSummary[]): LinkIndex {
  const index: LinkIndex = { paths: new Map(), foldedPaths: new Map(), ids: new Map(), filenames: new Map() };
  for (const note of notes) {
    index.paths.set(note.path, note);
    index.foldedPaths.set(note.path.toLocaleLowerCase(), note);
    const id = note.frontmatter.id;
    if (typeof id === "string") appendIndex(index.ids, id, note);
    appendIndex(index.filenames, basename(note.path), note);
  }
  return index;
}

function appendIndex(index: Map<string, NoteSummary[]>, key: string, note: NoteSummary) {
  const values = index.get(key);
  if (values) values.push(note);
  else index.set(key, [note]);
}

function cleanTarget(value: string): string {
  const unaliased = value.split("|", 1)[0].split("#", 1)[0].trim().replaceAll("\\", "/");
  try {
    return decodeURIComponent(unaliased);
  } catch {
    return unaliased;
  }
}

function joinPath(parent: string, child: string): string {
  return normalizePath(parent ? `${parent}/${child}` : child);
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}
