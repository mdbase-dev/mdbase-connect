import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { CollectionFile, NoteSummary } from "./model";
import { noteTitle } from "./note";
import type { NoteSort } from "./note-list-view";
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
  }, [files, filter, query]);
  const entries = useMemo(
    () => collectionBrowserEntries(notes, visibleFiles, sort, types, Boolean(query.trim())),
    [notes, query, sort, types, visibleFiles]
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
  if (sort === "modified-desc" || sort === "modified-asc") {
    const modified = compareModified(left, right, sort === "modified-desc" ? -1 : 1);
    if (modified !== 0) return modified;
  } else if (sort === "title-asc") {
    const title = collator.compare(entryTitle(left, types), entryTitle(right, types));
    if (title !== 0) return title;
  } else {
    const path = collator.compare(left.path, right.path);
    if (path !== 0) return path;
  }
  return collator.compare(left.path, right.path);
}

function compareModified(left: CollectionBrowserEntry, right: CollectionBrowserEntry, direction: -1 | 1): number {
  const leftTime = modifiedTime(left);
  const rightTime = modifiedTime(right);
  if (leftTime === undefined && rightTime === undefined) return 0;
  if (leftTime === undefined) return 1;
  if (rightTime === undefined) return -1;
  return (leftTime - rightTime) * direction;
}

function modifiedTime(entry: CollectionBrowserEntry): number | undefined {
  const value = entry.kind === "file" ? entry.file.modifiedAt : entry.note.file?.mtime;
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function entryTitle(entry: CollectionBrowserEntry, types: CollectionTypeDescriptor[]): string {
  return entry.kind === "file" ? collectionFileTitle(entry.file) : noteTitle(entry.note, types);
}

function trimNumber(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}
