import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { NoteSummary } from "./model";
import { basename, folder, noteTitle } from "./note";

export interface LinkSuggestion {
  path: string;
  title: string;
  aliases?: string[];
  types?: string[];
}

export interface LinkMatch {
  suggestion: LinkSuggestion;
  label: string;
  rank: number;
}

export interface LinkMatchContext {
  currentPath?: string;
  recentPaths?: string[];
}

export interface UnresolvedNoteTarget {
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

interface IndexedSuggestion {
  suggestion: LinkSuggestion;
  title: string;
  aliases: string[];
  path: string;
  types: string[];
}

const suggestionIndexes = new WeakMap<LinkSuggestion[], IndexedSuggestion[]>();

export function linkSuggestions(
  notes: NoteSummary[],
  declaredTypes: string[] = [],
  types: CollectionTypeDescriptor[] = []
): LinkSuggestion[] {
  const declared = new Set(declaredTypes);
  return notes
    .map((note) => ({
      path: note.path,
      title: noteTitle(note, types),
      aliases: noteAliases(note),
      types: declared.size ? note.types.filter((type) => declared.has(type)) : note.types
    }))
    .sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path));
}

export function linkMatches(
  suggestions: LinkSuggestion[],
  query: string,
  type?: string,
  limit = Number.POSITIVE_INFINITY,
  context: LinkMatchContext = {}
): LinkMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  const typeName = type?.toLocaleLowerCase();
  const sourceFolder = context.currentPath ? folder(context.currentPath) : undefined;
  const recent = new Map((context.recentPaths ?? []).map((path, index) => [path, index]));
  const candidates = indexedSuggestions(suggestions)
    .filter((entry) => !typeName || entry.types.includes(typeName));
  return candidates
    .map((entry) => ({
      ...bestLinkMatch(entry, needle),
      sameFolder: sourceFolder !== undefined && folder(entry.suggestion.path) === sourceFolder,
      recent: recent.get(entry.suggestion.path) ?? Number.POSITIVE_INFINITY
    }))
    .filter((match) => Number.isFinite(match.rank))
    .sort((left, right) => left.rank - right.rank
      || left.recent - right.recent
      || Number(right.sameFolder) - Number(left.sameFolder)
      || left.label.localeCompare(right.label)
      || left.suggestion.path.localeCompare(right.suggestion.path))
    .slice(0, limit)
    .map(({ suggestion, label, rank }) => ({ suggestion, label, rank }));
}

export function backlinksFor(
  targetPath: string,
  notes: NoteSummary[],
  types: CollectionTypeDescriptor[] = []
): NoteSummary[] {
  const index = linkIndex(notes);
  return notes
    .filter((note) => referencesFor(note).some((reference) => resolveReference(note.path, reference, index)?.path === targetPath))
    .sort((left, right) => noteTitle(left, types).localeCompare(noteTitle(right, types)) || left.path.localeCompare(right.path));
}

export function wikilinkFor(suggestion: LinkSuggestion, label = suggestion.title): string {
  const target = suggestion.path.replace(/\.md$/i, "");
  return basename(suggestion.path).localeCompare(label, undefined, { sensitivity: "accent" }) === 0
    ? target
    : `${target}|${label}`;
}

export function unresolvedNoteTarget(
  target: string,
  label: string | undefined,
  sourcePath: string | undefined,
  format: "wikilink" | "markdown"
): UnresolvedNoteTarget | undefined {
  const rawTarget = target.split("#", 1)[0].split("?", 1)[0].trim().replaceAll("\\", "/");
  if (!rawTarget || rawTarget.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(rawTarget)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawTarget);
  } catch {
    decoded = rawTarget;
  }
  const sourceFolder = sourcePath ? folder(sourcePath) : "";
  const rootRelative = decoded.startsWith("/");
  const explicitlyRelative = decoded.startsWith("./") || decoded.startsWith("../");
  const base = rootRelative
    ? ""
    : format === "markdown" || explicitlyRelative || !decoded.includes("/")
      ? sourceFolder
      : "";
  const path = normalizeNewNotePath(base, decoded.replace(/^\/+/, ""));
  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  const extension = path.split("/").at(-1)?.match(/(\.[^./]+)$/)?.[1];
  if (extension && extension.toLocaleLowerCase() !== ".md") return undefined;
  const markdownPath = extension ? path : `${path}.md`;
  const title = label?.trim() || basename(markdownPath);
  return title ? { path: markdownPath, title } : undefined;
}

function normalizeNewNotePath(base: string, target: string): string | undefined {
  const parts = base.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function bestLinkMatch(entry: IndexedSuggestion, query: string): LinkMatch {
  const { suggestion } = entry;
  let best = { label: suggestion.title, rank: textRank(entry.title, query) };
  for (let index = 0; index < entry.aliases.length; index += 1) {
    const label = suggestion.aliases![index];
    const rank = textRank(entry.aliases[index], query);
    const exactAlias = entry.aliases[index] === query && best.label.toLocaleLowerCase() !== query;
    if (rank < best.rank || (rank === best.rank && exactAlias)) best = { label, rank };
  }
  const pathRank = pathMatchRank(entry.path, query);
  return { suggestion, label: best.label, rank: Math.min(best.rank, pathRank) };
}

function textRank(value: string, query: string): number {
  if (!query) return 0;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  if (value.split(/[\s/_.-]+/).some((part) => part.startsWith(query))) return 2;
  if (value.includes(query)) return 3;
  if (isSubsequence(query, value)) return 4;
  return Number.POSITIVE_INFINITY;
}

function pathMatchRank(path: string, query: string): number {
  if (!query) return 0;
  const filename = path.split("/").at(-1) ?? path;
  if (filename.startsWith(query)) return 1;
  if (path.startsWith(query)) return 2;
  if (path.includes(query)) return 3;
  if (isSubsequence(query, filename)) return 4;
  return Number.POSITIVE_INFINITY;
}

function indexedSuggestions(suggestions: LinkSuggestion[]): IndexedSuggestion[] {
  const cached = suggestionIndexes.get(suggestions);
  if (cached) return cached;
  const indexed = suggestions.map((suggestion) => ({
    suggestion,
    title: suggestion.title.toLocaleLowerCase(),
    aliases: (suggestion.aliases ?? []).map((alias) => alias.toLocaleLowerCase()),
    path: suggestion.path.toLocaleLowerCase(),
    types: (suggestion.types ?? []).map((type) => type.toLocaleLowerCase())
  }));
  suggestionIndexes.set(suggestions, indexed);
  return indexed;
}

function isSubsequence(query: string, value: string): boolean {
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function noteAliases(note: NoteSummary): string[] {
  const values = [
    note.effective_frontmatter.aliases,
    note.effective_frontmatter.alias
  ];
  const aliases = values.flatMap((value) => {
    if (typeof value === "string") return value.split(",");
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    return [];
  }).map((value) => value.trim()).filter(Boolean);
  return [...new Set(aliases)];
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
    const id = note.effective_frontmatter.id;
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
