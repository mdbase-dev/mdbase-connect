import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { NoteSummary } from "./model";
import { noteTitle } from "./note";

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
