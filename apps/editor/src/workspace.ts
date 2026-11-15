import { useCallback, useRef, useState } from "react";

/** The notes opened in the editor, oldest first, and where Back and Forward stand in them. */
export interface NoteHistory {
  readonly paths: readonly string[];
  readonly index: number;
}

export const emptyNoteHistory: NoteHistory = { paths: [], index: -1 };
const LIMIT = 100;

/** Opening a note drops anything Forward of the current one; reopening the current note changes nothing. */
export function visitNote(history: NoteHistory, path: string): NoteHistory {
  if (history.paths[history.index] === path) return history;
  const paths = [...history.paths.slice(0, history.index + 1), path].slice(-LIMIT);
  return { paths, index: paths.length - 1 };
}

/** Back or Forward arrived at `index`, unless the history changed under it while the note opened. */
export function returnToNote(history: NoteHistory, index: number, path: string): NoteHistory {
  return history.paths[index] === path && history.index !== index ? { paths: history.paths, index } : history;
}

/** Where Back (-1) or Forward (1) goes from here. */
export function historyStep(history: NoteHistory, direction: -1 | 1): { path: string; index: number } | undefined {
  const index = history.index + direction;
  const path = history.paths[index];
  return path === undefined ? undefined : { path, index };
}

export function renameInHistory(history: NoteHistory, from: string, to: string): NoteHistory {
  if (!history.paths.includes(from)) return history;
  return { paths: history.paths.map((path) => path === from ? to : path), index: history.index };
}

/** A deleted note leaves the history; the visits either side of it, now adjacent, may be one note. */
export function forgetInHistory(history: NoteHistory, forgotten: string): NoteHistory {
  if (!history.paths.includes(forgotten)) return history;
  const paths: string[] = [];
  let index = -1;
  history.paths.forEach((path, position) => {
    if (path !== forgotten && path !== paths.at(-1)) paths.push(path);
    if (position === history.index) index = paths.length - 1;
  });
  return { paths, index };
}

/** The history as rendered, and the latest one for callbacks that run between renders. */
export function useNoteHistory() {
  const latest = useRef(emptyNoteHistory);
  const [history, setHistory] = useState(emptyNoteHistory);
  const changeHistory = useCallback((change: (current: NoteHistory) => NoteHistory) => {
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setHistory(next);
  }, []);
  return { history, latest, changeHistory };
}

const LAST_NOTE_PREFIX = "mdbase-editor:last-note:";

/** The note to reopen when this collection opens again. */
export function lastOpenNote(collectionId: string): string | undefined {
  try { return localStorage.getItem(LAST_NOTE_PREFIX + collectionId) ?? undefined; }
  catch { return undefined; }
}

export function rememberOpenNote(collectionId: string, path: string): void {
  try { localStorage.setItem(LAST_NOTE_PREFIX + collectionId, path); }
  catch { /* Reopening the last note is a convenience; without storage the newest note opens. */ }
}
