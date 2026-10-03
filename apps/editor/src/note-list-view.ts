import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { NoteSummary } from "./model";
import { noteTitle } from "./note";

export const NOTE_PATHS_MIME = "application/x-mdbase-note-paths";
export type NoteFilter = { kind: "folder" | "tag" | "type"; value: string };
export interface SearchFacet { name: string; count: number }
export interface NoteRowStatus {
  label?: string;
  tone: "quiet" | "busy" | "error";
  busy: boolean;
  disabled?: boolean;
}

export function filterLabel(filter: NoteFilter | undefined, fallback: string): string {
  if (!filter) return fallback || "All notes";
  return filter.kind === "tag" ? `#${filter.value}` : filter.value;
}

export function filterScopeLabel(filter: NoteFilter | undefined): string | undefined {
  if (!filter) return undefined;
  if (filter.kind === "folder") return `Folder · ${filter.value}`;
  if (filter.kind === "tag") return `Tag · #${filter.value}`;
  return `Type · ${filter.value}`;
}

export const noteSorts = ["modified-desc", "modified-asc", "title-asc", "path-asc"] as const;
export type NoteSort = (typeof noteSorts)[number];

export const defaultNoteSort: NoteSort = "modified-desc";

export const noteSortOptions: ReadonlyArray<{
  value: NoteSort;
  label: string;
  summary: string;
}> = [
  { value: "modified-desc", label: "Modified newest", summary: "modified newest" },
  { value: "modified-asc", label: "Modified oldest", summary: "modified oldest" },
  { value: "title-asc", label: "Title A–Z", summary: "title A–Z" },
  { value: "path-asc", label: "Path A–Z", summary: "path A–Z" }
];

const storageKey = "mdbase-editor:note-sort";
const noteCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function loadNoteSort(): NoteSort {
  try {
    const value = localStorage.getItem(storageKey);
    return noteSorts.includes(value as NoteSort) ? value as NoteSort : defaultNoteSort;
  } catch {
    return defaultNoteSort;
  }
}

export function saveNoteSort(value: NoteSort): void {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // Sorting still works for this session when storage is unavailable.
  }
}

export function noteSortSummary(value: NoteSort): string {
  return noteSortOptions.find((option) => option.value === value)?.summary ?? noteSortOptions[0].summary;
}

export function sortNotes(
  notes: NoteSummary[],
  sort: NoteSort,
  types: CollectionTypeDescriptor[] = []
): NoteSummary[] {
  return [...notes].sort((left, right) => {
    if (sort === "modified-desc" || sort === "modified-asc") {
      const modified = compareModified(left, right, sort === "modified-desc" ? -1 : 1);
      if (modified !== 0) return modified;
    } else if (sort === "title-asc") {
      const title = noteCollator.compare(noteTitle(left, types), noteTitle(right, types));
      if (title !== 0) return title;
    } else {
      const path = noteCollator.compare(left.path, right.path);
      if (path !== 0) return path;
    }
    return noteCollator.compare(left.path, right.path);
  });
}

function compareModified(left: NoteSummary, right: NoteSummary, direction: -1 | 1): number {
  const leftTime = modifiedTime(left);
  const rightTime = modifiedTime(right);
  if (leftTime === undefined && rightTime === undefined) return 0;
  if (leftTime === undefined) return 1;
  if (rightTime === undefined) return -1;
  return (leftTime - rightTime) * direction;
}

function modifiedTime(note: NoteSummary): number | undefined {
  const value = Date.parse(note.file?.mtime ?? "");
  return Number.isFinite(value) ? value : undefined;
}

export interface NoteSelection {
  paths: string[];
  /** Range origin and the note kept open in the editor. */
  anchor?: string;
  /** Keyboard focus may travel independently from the open note. */
  focus?: string;
}

export function selectNote(selection: NoteSelection, path: string, visiblePaths: string[], mode: "single" | "toggle" | "range"): NoteSelection {
  if (mode === "single") return { paths: [path], anchor: path, focus: path };
  const anchor = selection.anchor && visiblePaths.includes(selection.anchor) ? selection.anchor : path;
  if (mode === "range") {
    const start = visiblePaths.indexOf(anchor);
    const end = visiblePaths.indexOf(path);
    return { paths: visiblePaths.slice(Math.min(start, end), Math.max(start, end) + 1), anchor, focus: path };
  }
  return {
    paths: selection.paths.includes(path) ? selection.paths.filter((value) => value !== path) : [...selection.paths, path],
    anchor, focus: path
  };
}

const pinStorageKey = (collectionId: string) => `mdbase-editor:pins:${collectionId}`;

export function loadPinnedNotes(collectionId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(pinStorageKey(collectionId)) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((path): path is string => typeof path === "string"))] : [];
  } catch { return []; }
}

export function savePinnedNotes(collectionId: string, paths: string[]): void {
  try { localStorage.setItem(pinStorageKey(collectionId), JSON.stringify(paths)); }
  catch { /* Pins remain usable for this session when storage is unavailable. */ }
}

export type ListNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";

export function moveListIndex(current: number, count: number, key: ListNavigationKey, pageSize = 10): number {
  if (count <= 0) return -1;
  const clamped = Math.min(Math.max(current, -1), count - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return clamped >= count - 1 ? count - 1 : clamped + 1;
  if (key === "ArrowUp") return clamped <= 0 ? 0 : clamped - 1;
  if (key === "PageDown") return Math.min(count - 1, (clamped < 0 ? 0 : clamped) + pageSize);
  return Math.max(0, (clamped < 0 ? 0 : clamped) - pageSize);
}
