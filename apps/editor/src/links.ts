import type { CollectionTypeDescriptor } from "./connect-types";
import type { NoteSummary } from "./model";
import { basename, folder, noteTitle } from "./note";

export function internalLink(target: string): boolean {
  return !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
}

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
  allowedTypes?: readonly string[];
  excludedPaths?: ReadonlySet<string>;
}

export interface UnresolvedNoteTarget {
  path: string;
  title: string;
}

interface IndexedSuggestion {
  suggestion: LinkSuggestion;
  title: string;
  aliases: string[];
  path: string;
  filename: string;
  folder: string;
  types: string[];
}

const suggestionIndexes = new WeakMap<LinkSuggestion[], IndexedSuggestion[]>();
const suggestionsByPath = new WeakMap<LinkSuggestion[], Map<string, LinkSuggestion>>();

export function linkSuggestionAt(suggestions: LinkSuggestion[], path: string): LinkSuggestion | undefined {
  let byPath = suggestionsByPath.get(suggestions);
  if (!byPath) {
    byPath = new Map();
    for (const suggestion of suggestions) byPath.set(suggestion.path, suggestion);
    suggestionsByPath.set(suggestions, byPath);
  }
  return byPath.get(path);
}

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
  const types = type ? [type] : context.allowedTypes ?? [];
  const wanted = new Set(types.map(name => name.toLocaleLowerCase()));
  const sourceFolder = context.currentPath ? folder(context.currentPath) : undefined;
  const recent = new Map((context.recentPaths ?? []).map((path, index) => [path, index]));
  const singleWord = !wordSeparator.test(needle);
  const ranks: (LinkMatch & { recent: number; sameFolder: boolean })[][] = [[], [], [], [], []];
  for (const entry of indexedSuggestions(suggestions)) {
    if (context.excludedPaths?.has(entry.suggestion.path)
      || (wanted.size && !entry.types.some(name => wanted.has(name)))) continue;
    const match = bestLinkMatch(entry, needle, singleWord);
    if (!Number.isFinite(match.rank)) continue;
    ranks[match.rank].push({
      ...match, recent: recent.get(entry.suggestion.path) ?? Infinity, sameFolder: sourceFolder === entry.folder
    });
  }
  // Sort only the ranks that can appear in the picker.
  const results: LinkMatch[] = [];
  for (const rank of ranks) {
    if (results.length >= limit) break;
    rank.sort((left, right) => left.recent - right.recent
      || Number(right.sameFolder) - Number(left.sameFolder)
      || left.label.localeCompare(right.label)
      || left.suggestion.path.localeCompare(right.suggestion.path));
    for (const { suggestion, label, rank: score } of rank.slice(0, limit - results.length)) {
      results.push({ suggestion, label, rank: score });
    }
  }
  return results;
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

function bestLinkMatch(entry: IndexedSuggestion, query: string, singleWord: boolean): LinkMatch {
  const { suggestion } = entry;
  let best = { label: suggestion.title, rank: textRank(entry.title, query, singleWord) };
  for (let index = 0; index < entry.aliases.length; index += 1) {
    const label = suggestion.aliases![index];
    const rank = textRank(entry.aliases[index], query, singleWord);
    const exactAlias = entry.aliases[index] === query && best.label.toLocaleLowerCase() !== query;
    if (rank < best.rank || (rank === best.rank && exactAlias)) best = { label, rank };
  }
  const pathRank = best.rank === 0 ? 0 : pathMatchRank(entry.path, entry.filename, query);
  return { suggestion, label: best.label, rank: Math.min(best.rank, pathRank) };
}

const wordSeparator = /[\s/_.-]/;

function textRank(value: string, query: string, singleWord: boolean): number {
  if (!query) return 0;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  const first = value.indexOf(query);
  if (first !== -1) {
    if (singleWord) {
      for (let index = first; index !== -1; index = value.indexOf(query, index + 1)) {
        if (wordSeparator.test(value[index - 1])) return 2;
      }
    }
    return 3;
  }
  if (isSubsequence(query, value)) return 4;
  return Number.POSITIVE_INFINITY;
}

function pathMatchRank(path: string, filename: string, query: string): number {
  if (!query) return 0;
  if (filename.startsWith(query)) return 1;
  if (path.startsWith(query)) return 2;
  if (path.includes(query)) return 3;
  if (isSubsequence(query, filename)) return 4;
  return Number.POSITIVE_INFINITY;
}

function indexedSuggestions(suggestions: LinkSuggestion[]): IndexedSuggestion[] {
  const cached = suggestionIndexes.get(suggestions);
  if (cached) return cached;
  const indexed = suggestions.map((suggestion) => {
    const path = suggestion.path.toLocaleLowerCase();
    return {
      suggestion,
      title: suggestion.title.toLocaleLowerCase(),
      aliases: (suggestion.aliases ?? []).map((alias) => alias.toLocaleLowerCase()),
      path,
      filename: path.slice(path.lastIndexOf("/") + 1),
      folder: folder(suggestion.path),
      types: (suggestion.types ?? []).map((type) => type.toLocaleLowerCase())
    };
  });
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

export function noteAliases(note: NoteSummary): string[] {
  const values = [
    note.effectiveFrontmatter.aliases,
    note.effectiveFrontmatter.alias
  ];
  const aliases = values.flatMap((value) => {
    if (typeof value === "string") return value.split(",");
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
    return [];
  }).map((value) => value.trim()).filter(Boolean);
  return [...new Set(aliases)];
}
