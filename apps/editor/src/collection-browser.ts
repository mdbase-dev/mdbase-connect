import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { displayLocale } from "./i18n/format";
import type { CollectionFile, NoteSummary } from "./model";
import { noteTitle } from "./note";
import { noteFieldValue, type NoteSort, type SortField } from "./note-sort";
import { useMemo } from "react";

type BrowserFilter = { kind: "folder" | "tag" | "type"; value: string };

export type CollectionBrowserEntry =
  | { kind: "note"; path: string; note: NoteSummary }
  | { kind: "file"; path: string; file: CollectionFile };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function collectionBrowserEntries(
  notes: readonly NoteSummary[],
  files: readonly CollectionFile[],
  sort: NoteSort,
  types: CollectionTypeDescriptor[] = [],
  preserveNoteOrder = false
): CollectionBrowserEntry[] {
  const noteEntries: CollectionBrowserEntry[] = notes.map((note) => ({ kind: "note", path: note.path, note }));
  const fileEntries: CollectionBrowserEntry[] = files.map((file) => ({ kind: "file", path: file.path, file }));
  if (preserveNoteOrder) return [...noteEntries, ...fileEntries.sort((left, right) => collator.compare(left.path, right.path))];
  return [...noteEntries, ...fileEntries].sort((left, right) => compareEntries(left, right, sort, types));
}

export function useCollectionBrowserEntries(
  notes: readonly NoteSummary[],
  files: readonly CollectionFile[],
  filter: BrowserFilter | undefined,
  query: string,
  sort: NoteSort,
  types: CollectionTypeDescriptor[]
) {
  const visibleFiles = useMemo(() => {
    if (filter && filter.kind !== "folder") return [];
    const needle = query.trim().toLocaleLowerCase();
    return files.filter((file) => (!filter || file.path === filter.value || file.path.startsWith(`${filter.value}/`))
      && (!needle || file.path.toLocaleLowerCase().includes(needle)));
  }, [files, filter, query, i18n.locale]);
  const entries = useMemo(
    () => collectionBrowserEntries(notes, visibleFiles, sort, types, Boolean(query.trim())),
    [notes, query, sort, types, visibleFiles, i18n.locale]
  );
  return { visibleFiles, entries };
}

export function collectionFileTitle(file: CollectionFile): string {
  return file.path.split("/").at(-1) || file.path;
}

export function collectionFileFormat(file: CollectionFile): string {
  const extension = collectionFileTitle(file).match(/\.([^.]+)$/)?.[1];
  return (extension || file.mediaClass).toLocaleUpperCase();
}

export function formatFileSize(size: number): string {
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${trimNumber(size / 1_000)} KB`;
  if (size < 1_000_000_000) return `${trimNumber(size / 1_000_000)} MB`;
  return `${trimNumber(size / 1_000_000_000)} GB`;
}

function compareEntries(
  left: CollectionBrowserEntry,
  right: CollectionBrowserEntry,
  sort: NoteSort,
  types: CollectionTypeDescriptor[]
): number {
  const direction = sort.direction === "desc" ? -1 : 1;
  const order = sort.key === "field" ? compareOptional(entryFieldValue(left, sort.field), entryFieldValue(right, sort.field), direction)
    : sort.key === "modified" ? compareOptional(modifiedTime(left), modifiedTime(right), direction)
    : sort.key === "title" ? collator.compare(entryTitle(left, types), entryTitle(right, types)) * direction
    : collator.compare(left.path, right.path) * direction;
  return order || collator.compare(left.path, right.path);
}

/** Entries without a value stay last in either direction. */
function compareOptional(left: number | string | undefined, right: number | string | undefined, direction: -1 | 1): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return (typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right))) * direction;
}

function entryFieldValue(entry: CollectionBrowserEntry, field: SortField): number | string | undefined {
  return entry.kind === "note" ? noteFieldValue(entry.note, field) : undefined;
}

function modifiedTime(entry: CollectionBrowserEntry): number | undefined {
  const value = entry.kind === "file" ? entry.file.modifiedAt : entry.note.file?.mtime;
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function entryTitle(entry: CollectionBrowserEntry, types: CollectionTypeDescriptor[]): string {
  return entry.kind === "file" ? collectionFileTitle(entry.file) : noteTitle(entry.note, types);
}

export function browserGroupLabel(entry: CollectionBrowserEntry, sort: NoteSort, types: CollectionTypeDescriptor[] = [], now = new Date()): string {
  if (sort.key === "path") return entryPathFolder(entry.path);
  if (sort.key === "title") return titleGroupLabel(entryTitle(entry, types));
  if (sort.key === "field") return fieldGroupLabel(entryFieldValue(entry, sort.field), sort.field);
  return modifiedGroupLabel(modifiedTime(entry), now);
}

function fieldGroupLabel(value: number | string | undefined, field: SortField): string {
  if (value === undefined) return t`No value`;
  if (field.kind === "choice") return String(field.choices[value as number]);
  if (field.kind === "text") return titleGroupLabel(value as string);
  if (field.kind === "number") return field.label;
  // Date-only values parse as UTC midnight, which is the previous day west of Greenwich.
  return new Intl.DateTimeFormat(displayLocale(), { month: "long", year: "numeric", ...(field.kind === "date" ? { timeZone: "UTC" } : {}) }).format(value as number);
}

function entryPathFolder(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : t`Collection root`;
}

function titleGroupLabel(title: string): string {
  const letter = title.trim().toLocaleUpperCase().at(0);
  return letter && /\p{L}/u.test(letter) ? letter : "#";
}

function modifiedGroupLabel(timestamp: number | undefined, now: Date): string {
  if (timestamp === undefined) return t`Undated`;
  const date = new Date(timestamp);
  const startOfToday = startOfDay(now);
  const day = Math.floor((startOfToday - startOfDay(date)) / 86_400_000);
  if (day <= 0) return t`Today`;
  if (day === 1) return t`Yesterday`;
  if (day < 7) return t`Previous 7 days`;
  if (day < 30) return t`Previous 30 days`;
  return t`Older`;
}

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export interface BrowserListItem {
  key: string;
  kind: "header" | "entry";
  label?: string;
  entry?: CollectionBrowserEntry;
  entryIndex?: number;
}

export function browserListItems(
  entries: readonly CollectionBrowserEntry[],
  sort: NoteSort,
  types: CollectionTypeDescriptor[] = [],
  now = new Date(),
  searching = false,
  pinnedPaths: ReadonlySet<string> = new Set()
): BrowserListItem[] {
  const items: BrowserListItem[] = [];
  if (searching) {
    // Relevance order has no meaningful groups; recency headers would contradict it.
    entries.forEach((entry, entryIndex) => items.push({ key: entry.kind === "file" ? `file:${entry.file.fileId}` : `note:${entry.note.path}`, kind: "entry", entry, entryIndex }));
    return items;
  }
  let currentLabel: string | undefined;
  let headerCount = 0;
  entries.forEach((entry, entryIndex) => {
    const label = entry.kind === "note" && pinnedPaths.has(entry.path) ? t`Pinned` : browserGroupLabel(entry, sort, types, now);
    if (label !== currentLabel) {
      currentLabel = label;
      items.push({ key: `header:${headerCount}:${label}`, kind: "header", label });
      headerCount += 1;
    }
    items.push({ key: entry.kind === "file" ? `file:${entry.file.fileId}` : `note:${entry.note.path}`, kind: "entry", entry, entryIndex });
  });
  return items;
}

function trimNumber(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}
