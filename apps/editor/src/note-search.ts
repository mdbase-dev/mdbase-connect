import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { NoteSummary } from "./model";
import { basename, noteTags, noteTitle } from "./note";

export interface NoteSearchEntry {
  note: NoteSummary;
  title: string;
  filename: string;
  path: string;
  metadata: string;
  body: string;
  metadataText: string;
  bodyText: string;
}

export interface NoteSearchContext {
  kind: "path" | "metadata" | "body";
  text: string;
  ranges: SearchTextRange[];
}

export interface NoteSearchResult {
  note: NoteSummary;
  context: NoteSearchContext;
}

export interface SearchTextRange {
  from: number;
  to: number;
}

/** Reuses normalized entries for records whose object identity has not changed. */
export class IncrementalNoteSearchIndex {
  private entries = new Map<string, { note: NoteSummary; typeKey: string; entry: NoteSearchEntry }>();

  build(notes: NoteSummary[], types: CollectionTypeDescriptor[] = []): NoteSearchEntry[] {
    const typeKey = JSON.stringify(types.map((type) => [type.name, type.collection]));
    const currentPaths = new Set(notes.map((note) => note.path));
    for (const path of this.entries.keys()) {
      if (!currentPaths.has(path)) this.entries.delete(path);
    }
    return notes.map((note) => {
      const cached = this.entries.get(note.path);
      if (cached?.note === note && cached.typeKey === typeKey) return cached.entry;
      const entry = buildNoteSearchEntry(note, types);
      this.entries.set(note.path, { note, typeKey, entry });
      return entry;
    });
  }

  clear(): void {
    this.entries.clear();
  }
}

export function buildNoteSearchIndex(
  notes: NoteSummary[],
  types: CollectionTypeDescriptor[] = []
): NoteSearchEntry[] {
  return notes.map((note) => buildNoteSearchEntry(note, types));
}

function buildNoteSearchEntry(note: NoteSummary, types: CollectionTypeDescriptor[]): NoteSearchEntry {
  const metadata: string[] = [...note.types, ...noteTags(note)];
  collectSearchValues(note.effectiveFrontmatter, metadata);
  const metadataText = readableMetadata(note);
  return {
    note,
    title: normalize(noteTitle(note, types)),
    filename: normalize(basename(note.path)),
    path: normalize(note.path),
    metadata: normalize(metadata.join("\n")),
    body: normalize(note.body ?? ""),
    metadataText,
    bodyText: note.body ?? ""
  };
}

export function searchNotes(index: NoteSearchEntry[], query: string, limit = Number.POSITIVE_INFINITY): NoteSummary[] {
  return searchNoteResults(index, query, limit).map((result) => result.note);
}

export function searchNoteResults(
  index: NoteSearchEntry[],
  query: string,
  limit = Number.POSITIVE_INFINITY
): NoteSearchResult[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return index.slice(0, limit).map((entry) => ({
      note: entry.note,
      context: searchContext(entry.note.path, query, "path")
    }));
  }
  return index
    .map((entry, order) => ({ entry, order, score: noteScore(entry, tokens) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, limit)
    .map((candidate) => ({
      note: candidate.entry.note,
      context: bestSearchContext(candidate.entry, query, tokens)
    }));
}

function noteScore(entry: NoteSearchEntry, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    const tokenScore = Math.min(
      fuzzyScore(entry.title, token),
      fuzzyScore(entry.filename, token) + 0.35,
      fuzzyScore(entry.path, token) + 0.75,
      substringScore(entry.metadata, token) + 2,
      substringScore(entry.body, token) + 4
    );
    if (!Number.isFinite(tokenScore)) return Number.POSITIVE_INFINITY;
    score += tokenScore;
  }
  return score + Math.min(entry.path.length / 1_000, 0.25);
}

function fuzzyScore(value: string, query: string): number {
  if (value === query) return 0;
  if (value.startsWith(query)) return 0.4;
  const wordIndex = value.search(new RegExp(`(?:^|[\\s/_.-])${escapeRegExp(query)}`));
  if (wordIndex >= 0) return 0.8 + wordIndex / 1_000;
  const substring = value.indexOf(query);
  if (substring >= 0) return 1.4 + substring / 1_000;

  let queryIndex = 0;
  let first = -1;
  let last = -1;
  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (first < 0) first = valueIndex;
    last = valueIndex;
    queryIndex += 1;
  }
  if (queryIndex !== query.length) return Number.POSITIVE_INFINITY;
  return 2.2 + (last - first - query.length + 1) * 0.08 + first * 0.005;
}

function substringScore(value: string, query: string): number {
  const index = value.indexOf(query);
  return index < 0 ? Number.POSITIVE_INFINITY : index / 10_000;
}

function collectSearchValues(value: unknown, values: string[]) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    values.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchValues(item, values);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSearchValues(item, values);
  }
}

export function searchTextRanges(text: string, query: string): SearchTextRange[] {
  const haystack = text.toLocaleLowerCase();
  const tokens = [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  const ranges: SearchTextRange[] = [];
  for (const token of tokens) {
    let from = haystack.indexOf(token);
    while (from >= 0) {
      const to = from + token.length;
      if (!ranges.some((range) => from < range.to && to > range.from)) ranges.push({ from, to });
      from = haystack.indexOf(token, Math.max(to, from + 1));
    }
  }
  return ranges.sort((left, right) => left.from - right.from);
}

function bestSearchContext(entry: NoteSearchEntry, query: string, tokens: string[]): NoteSearchContext {
  const fields = [
    { kind: "title" as const, score: combinedScore(entry.title, tokens, fuzzyScore) },
    { kind: "filename" as const, score: combinedScore(entry.filename, tokens, fuzzyScore) + 0.35 },
    { kind: "path" as const, score: combinedScore(entry.path, tokens, fuzzyScore) + 0.75 },
    { kind: "metadata" as const, score: combinedScore(entry.metadata, tokens, substringScore) + 2 },
    { kind: "body" as const, score: combinedScore(entry.body, tokens, substringScore) + 4 }
  ].sort((left, right) => left.score - right.score);
  const best = fields.find((field) => Number.isFinite(field.score))?.kind;
  if (best === "body") return searchContext(entry.bodyText, query, "body", true);
  if (best === "metadata") return searchContext(entry.metadataText, query, "metadata", true);
  return searchContext(entry.note.path, query, "path");
}

function combinedScore(
  value: string,
  tokens: string[],
  score: (value: string, query: string) => number
): number {
  let total = 0;
  for (const token of tokens) {
    const next = score(value, token);
    if (!Number.isFinite(next)) return Number.POSITIVE_INFINITY;
    total += next;
  }
  return total;
}

function searchContext(
  value: string,
  query: string,
  kind: NoteSearchContext["kind"],
  excerpted = false
): NoteSearchContext {
  const text = excerpted ? searchExcerpt(value, query) : value;
  return { kind, text, ranges: searchTextRanges(text, query) };
}

function searchExcerpt(value: string, query: string, maximumLength = 104): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maximumLength) return text;
  const folded = text.toLocaleLowerCase();
  const matches = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    .map((token) => folded.indexOf(token))
    .filter((index) => index >= 0);
  const anchor = matches.length ? Math.min(...matches) : 0;
  let from = Math.max(0, anchor - Math.floor(maximumLength * 0.34));
  let to = Math.min(text.length, from + maximumLength);
  if (to === text.length) from = Math.max(0, to - maximumLength);
  if (from > 0) {
    const nextSpace = text.indexOf(" ", from);
    if (nextSpace >= 0 && nextSpace < anchor) from = nextSpace + 1;
  }
  if (to < text.length) {
    const previousSpace = text.lastIndexOf(" ", to);
    if (previousSpace > anchor) to = previousSpace;
  }
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

function readableMetadata(note: NoteSummary): string {
  const values = [
    ...note.types,
    ...noteTags(note).map((tag) => `#${tag}`)
  ];
  collectReadableMetadata(note.effectiveFrontmatter, values);
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].join(" · ");
}

function collectReadableMetadata(value: unknown, values: string[], key?: string) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    values.push(key ? `${key}: ${String(value)}` : String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReadableMetadata(item, values, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) collectReadableMetadata(item, values, childKey);
  }
}

function normalize(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
