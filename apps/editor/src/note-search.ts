import type { NoteSummary } from "./model";
import { basename, noteTags, noteTitle } from "./note";

export interface NoteSearchEntry {
  note: NoteSummary;
  title: string;
  filename: string;
  path: string;
  metadata: string;
  body: string;
}

export function buildNoteSearchIndex(notes: NoteSummary[]): NoteSearchEntry[] {
  return notes.map((note) => {
    const metadata: string[] = [...note.types, ...noteTags(note)];
    collectSearchValues(note.frontmatter, metadata);
    return {
      note,
      title: normalize(noteTitle(note)),
      filename: normalize(basename(note.path)),
      path: normalize(note.path),
      metadata: normalize(metadata.join("\n")),
      body: normalize(note.body ?? "")
    };
  });
}

export function searchNotes(index: NoteSearchEntry[], query: string, limit = Number.POSITIVE_INFINITY): NoteSummary[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return index.slice(0, limit).map((entry) => entry.note);
  return index
    .map((entry, order) => ({ entry, order, score: noteScore(entry, tokens) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, limit)
    .map((candidate) => candidate.entry.note);
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

function normalize(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
