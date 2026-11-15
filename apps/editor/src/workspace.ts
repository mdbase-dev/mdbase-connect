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

/** A tab shows the current note of its own history. */
export interface NoteTab {
  readonly id: string;
  readonly history: NoteHistory;
}

/** The open tabs, in order, and the one the editor shows. There is always a tab. */
export interface Workspace {
  readonly tabs: readonly NoteTab[];
  readonly active: string;
}

let tabCount = 0;
function newTab(history: NoteHistory): NoteTab {
  return { id: `tab-${++tabCount}`, history };
}

export function emptyWorkspace(): Workspace {
  const tab = newTab(emptyNoteHistory);
  return { tabs: [tab], active: tab.id };
}

export function activeTab(workspace: Workspace): NoteTab {
  return workspace.tabs.find((tab) => tab.id === workspace.active)!;
}

export function tabNote(tab: NoteTab): string | undefined {
  return tab.history.paths[tab.history.index];
}

export function changeActiveHistory(workspace: Workspace, change: (history: NoteHistory) => NoteHistory): Workspace {
  const tab = activeTab(workspace);
  const history = change(tab.history);
  return history === tab.history ? workspace : { ...workspace, tabs: workspace.tabs.map((each) => each === tab ? { ...tab, history } : each) };
}

/** A new tab opens on `path` beside the active one, and becomes active. */
export function openTab(workspace: Workspace, path: string): Workspace {
  const tab = newTab(visitNote(emptyNoteHistory, path));
  const at = workspace.tabs.indexOf(activeTab(workspace)) + 1;
  return { tabs: [...workspace.tabs.slice(0, at), tab, ...workspace.tabs.slice(at)], active: tab.id };
}

/** Closing the active tab activates the one to its right, or to its left at the end. The last tab stays open. */
export function closeTab(workspace: Workspace, id: string): Workspace {
  const at = workspace.tabs.findIndex((tab) => tab.id === id);
  if (at < 0 || workspace.tabs.length === 1) return workspace;
  const tabs = workspace.tabs.filter((tab) => tab.id !== id);
  return { tabs, active: id === workspace.active ? tabs[Math.min(at, tabs.length - 1)]!.id : workspace.active };
}

export function selectTab(workspace: Workspace, id: string): Workspace {
  return id === workspace.active || !workspace.tabs.some((tab) => tab.id === id) ? workspace : { ...workspace, active: id };
}

/** The next (1) or previous (-1) tab, wrapping around at either end. */
export function adjacentTab(workspace: Workspace, direction: -1 | 1): NoteTab {
  const at = workspace.tabs.indexOf(activeTab(workspace));
  return workspace.tabs[(at + direction + workspace.tabs.length) % workspace.tabs.length]!;
}

export function renameInWorkspace(workspace: Workspace, from: string, to: string): Workspace {
  if (!workspace.tabs.some((tab) => tab.history.paths.includes(from))) return workspace;
  return { ...workspace, tabs: workspace.tabs.map((tab) => ({ ...tab, history: renameInHistory(tab.history, from, to) })) };
}

/** A deleted note leaves every tab. A tab in the background goes back to the note it showed before,
 * or closes when it showed no other; the active tab's caller opens the next note in it. */
export function forgetInWorkspace(workspace: Workspace, path: string): Workspace {
  if (!workspace.tabs.some((tab) => tab.history.paths.includes(path))) return workspace;
  const tabs = workspace.tabs.flatMap((tab) => {
    const history = forgetInHistory(tab.history, path);
    if (tab.id === workspace.active) return [{ ...tab, history }];
    if (!history.paths.length) return [];
    return [{ ...tab, history: history.index < 0 ? { paths: history.paths, index: 0 } : history }];
  });
  return { tabs, active: workspace.active };
}

/** The workspace as rendered, and the latest one for callbacks that run between renders. */
export function useWorkspace() {
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const latest = useRef(workspace);
  const changeWorkspace = useCallback((change: (current: Workspace) => Workspace) => {
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setWorkspace(next);
  }, []);
  return { workspace, latest, changeWorkspace };
}

const TABS_PREFIX = "mdbase-editor:tabs:";

interface SavedWorkspace {
  tabs: NoteHistory[];
  active: number;
}

function isSavedWorkspace(value: unknown): value is SavedWorkspace {
  if (typeof value !== "object" || value === null) return false;
  const { tabs, active } = value as Partial<SavedWorkspace>;
  return Array.isArray(tabs) && tabs.length > 0 && Number.isInteger(active) && active! >= 0 && active! < tabs.length
    && tabs.every((tab) => Array.isArray(tab?.paths) && tab.paths.every((path) => typeof path === "string")
      && Number.isInteger(tab.index) && tab.index >= -1 && tab.index < tab.paths.length);
}

/** The tabs this device had open in the collection, or one empty tab when it had none or can't say. */
export function loadWorkspace(collectionId: string): Workspace {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(TABS_PREFIX + collectionId) ?? "null");
    if (isSavedWorkspace(saved)) {
      const tabs = saved.tabs.map(({ paths, index }) => newTab({ paths, index }));
      return { tabs, active: tabs[saved.active]!.id };
    }
  } catch { /* Unreadable storage restores no tabs. */ }
  return emptyWorkspace();
}

export function saveWorkspace(collectionId: string, workspace: Workspace): void {
  const saved: SavedWorkspace = {
    tabs: workspace.tabs.map(({ history }) => history),
    active: workspace.tabs.indexOf(activeTab(workspace))
  };
  try { localStorage.setItem(TABS_PREFIX + collectionId, JSON.stringify(saved)); }
  catch { /* Reopening tabs is a convenience; without storage the newest note opens. */ }
}
