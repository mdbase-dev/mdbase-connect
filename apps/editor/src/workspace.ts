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

/** A pane's tabs, in order, and the one it shows. A pane always has a tab. */
export interface Pane {
  readonly id: string;
  readonly tabs: readonly NoteTab[];
  readonly active: string;
}

/** Where the second pane sits: beside the first, or under it. */
export type SplitDirection = "right" | "down";

/** One pane, or two split `right` or `down`. The editor's commands act in the focused pane. */
export interface Workspace {
  readonly panes: readonly Pane[];
  readonly focused: number;
  readonly split: SplitDirection;
}

let tabCount = 0, paneCount = 0;
function newTab(history: NoteHistory): NoteTab {
  return { id: `tab-${++tabCount}`, history };
}

function paneOn(history: NoteHistory): Pane {
  const tab = newTab(history);
  return { id: `pane-${++paneCount}`, tabs: [tab], active: tab.id };
}

export function emptyWorkspace(): Workspace {
  return { panes: [paneOn(emptyNoteHistory)], focused: 0, split: "right" };
}

export function focusedPane(workspace: Workspace): Pane {
  return workspace.panes[workspace.focused]!;
}

export function paneTab(pane: Pane): NoteTab {
  return pane.tabs.find((tab) => tab.id === pane.active)!;
}

/** The focused pane's active tab. */
export function activeTab(workspace: Workspace): NoteTab {
  return paneTab(focusedPane(workspace));
}

export function tabNote(tab: NoteTab): string | undefined {
  return tab.history.paths[tab.history.index];
}

function changePane(workspace: Workspace, index: number, pane: Pane): Workspace {
  return pane === workspace.panes[index] ? workspace : { ...workspace, panes: workspace.panes.map((each, at) => at === index ? pane : each) };
}

export function changeActiveHistory(workspace: Workspace, change: (history: NoteHistory) => NoteHistory): Workspace {
  const pane = focusedPane(workspace), tab = paneTab(pane);
  const history = change(tab.history);
  return history === tab.history ? workspace
    : changePane(workspace, workspace.focused, { ...pane, tabs: pane.tabs.map((each) => each === tab ? { ...tab, history } : each) });
}

/** A new tab opens on `path` beside the active one in the focused pane, and becomes active. */
export function openTab(workspace: Workspace, path: string): Workspace {
  const pane = focusedPane(workspace);
  const tab = newTab(visitNote(emptyNoteHistory, path));
  const at = pane.tabs.indexOf(paneTab(pane)) + 1;
  return changePane(workspace, workspace.focused, { ...pane, tabs: [...pane.tabs.slice(0, at), tab, ...pane.tabs.slice(at)], active: tab.id });
}

function paneOf(workspace: Workspace, id: string): number {
  return workspace.panes.findIndex((pane) => pane.tabs.some((tab) => tab.id === id));
}

/** Closing a pane's active tab activates the one to its right, or to its left at the end. Closing a
 * pane's last tab closes the pane, unless it is the only one: the last tab stays open. */
export function closeTab(workspace: Workspace, id: string): Workspace {
  const index = paneOf(workspace, id);
  if (index < 0) return workspace;
  const pane = workspace.panes[index]!;
  if (pane.tabs.length === 1) return closePane(workspace, index);
  const at = pane.tabs.findIndex((tab) => tab.id === id);
  const tabs = pane.tabs.filter((tab) => tab.id !== id);
  return changePane(workspace, index, { ...pane, tabs, active: id === pane.active ? tabs[Math.min(at, tabs.length - 1)]!.id : pane.active });
}

/** Shows a tab, and focuses the pane it is in. */
export function selectTab(workspace: Workspace, id: string): Workspace {
  const index = paneOf(workspace, id);
  if (index < 0) return workspace;
  const focused = focusPane(workspace, index);
  return changePane(focused, index, { ...focused.panes[index]!, active: id });
}

/** The next (1) or previous (-1) tab in the focused pane, wrapping around at either end. */
export function adjacentTab(workspace: Workspace, direction: -1 | 1): NoteTab {
  const { tabs } = focusedPane(workspace);
  const at = tabs.indexOf(activeTab(workspace));
  return tabs[(at + direction + tabs.length) % tabs.length]!;
}

/** Opens a second pane on `path` and focuses it; with two open, moves the second pane to `direction`. */
export function splitPane(workspace: Workspace, direction: SplitDirection, path: string | undefined): Workspace {
  if (workspace.panes.length > 1) return direction === workspace.split ? workspace : { ...workspace, split: direction };
  return { panes: [workspace.panes[0]!, paneOn(path === undefined ? emptyNoteHistory : visitNote(emptyNoteHistory, path))], focused: 1, split: direction };
}

export function focusPane(workspace: Workspace, index: number): Workspace {
  return index === workspace.focused || !workspace.panes[index] ? workspace : { ...workspace, focused: index };
}

/** Closes a pane and its tabs; the other pane takes the whole editor and the focus. The only pane stays. */
export function closePane(workspace: Workspace, index: number): Workspace {
  if (workspace.panes.length === 1 || !workspace.panes[index]) return workspace;
  return { ...workspace, panes: workspace.panes.filter((_, at) => at !== index), focused: 0 };
}

/** Opens `path` in the pane that isn't focused, splitting to the right when there is one pane, and focuses it. */
export function openBeside(workspace: Workspace, path: string): Workspace {
  if (workspace.panes.length === 1) return splitPane(workspace, "right", path);
  return changeActiveHistory(focusPane(workspace, 1 - workspace.focused), (history) => visitNote(history, path));
}

export function renameInWorkspace(workspace: Workspace, from: string, to: string): Workspace {
  if (!workspace.panes.some((pane) => pane.tabs.some((tab) => tab.history.paths.includes(from)))) return workspace;
  return { ...workspace, panes: workspace.panes.map((pane) => ({ ...pane, tabs: pane.tabs.map((tab) => ({ ...tab, history: renameInHistory(tab.history, from, to) })) })) };
}

/** A deleted note leaves every tab. Any tab but the focused one goes back to the note it showed before,
 * or closes when it showed no other, and a pane left without tabs closes; the focused tab's caller opens
 * the next note in it. */
export function forgetInWorkspace(workspace: Workspace, path: string): Workspace {
  if (!workspace.panes.some((pane) => pane.tabs.some((tab) => tab.history.paths.includes(path)))) return workspace;
  const focusedTab = activeTab(workspace);
  const panes = workspace.panes.map((pane) => {
    const tabs = pane.tabs.flatMap((tab) => {
      const history = forgetInHistory(tab.history, path);
      if (tab === focusedTab) return [{ ...tab, history }];
      if (!history.paths.length) return [];
      return [{ ...tab, history: history.index < 0 ? { paths: history.paths, index: 0 } : history }];
    });
    const at = pane.tabs.findIndex((tab) => tab.id === pane.active);
    const active = tabs.some((tab) => tab.id === pane.active) ? pane.active
      : tabs[Math.min(at, tabs.length - 1)]?.id ?? pane.active;
    return { ...pane, tabs, active };
  });
  const kept = panes.filter((pane) => pane.tabs.length);
  return { ...workspace, panes: kept, focused: kept.indexOf(panes[workspace.focused]!) };
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

interface SavedPane {
  tabs: NoteHistory[];
  active: number;
}

/** The first pane's tabs, and a second pane's when the editor is split. */
interface SavedWorkspace extends SavedPane {
  split?: SavedPane & { direction: SplitDirection; focused: boolean };
}

function isSavedPane(value: unknown): value is SavedPane {
  if (typeof value !== "object" || value === null) return false;
  const { tabs, active } = value as Partial<SavedPane>;
  return Array.isArray(tabs) && tabs.length > 0 && Number.isInteger(active) && active! >= 0 && active! < tabs.length
    && tabs.every((tab) => Array.isArray(tab?.paths) && tab.paths.every((path) => typeof path === "string")
      && Number.isInteger(tab.index) && tab.index >= -1 && tab.index < tab.paths.length);
}

function isSavedWorkspace(value: unknown): value is SavedWorkspace {
  if (!isSavedPane(value)) return false;
  const { split } = value as SavedWorkspace;
  return split === undefined || isSavedPane(split) && (split.direction === "right" || split.direction === "down") && typeof split.focused === "boolean";
}

function restorePane({ tabs, active }: SavedPane): Pane {
  const restored = tabs.map(({ paths, index }) => newTab({ paths, index }));
  return { id: `pane-${++paneCount}`, tabs: restored, active: restored[active]!.id };
}

function savedPane(pane: Pane): SavedPane {
  return { tabs: pane.tabs.map(({ history }) => history), active: pane.tabs.indexOf(paneTab(pane)) };
}

/** The panes and tabs this device had open in the collection, or one empty tab when it had none or can't say. */
export function loadWorkspace(collectionId: string): Workspace {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(TABS_PREFIX + collectionId) ?? "null");
    if (isSavedWorkspace(saved)) {
      const { split } = saved;
      return split
        ? { panes: [restorePane(saved), restorePane(split)], focused: split.focused ? 1 : 0, split: split.direction }
        : { panes: [restorePane(saved)], focused: 0, split: "right" };
    }
  } catch { /* Unreadable storage restores no tabs. */ }
  return emptyWorkspace();
}

export function saveWorkspace(collectionId: string, workspace: Workspace): void {
  const [first, second] = workspace.panes;
  const saved: SavedWorkspace = {
    ...savedPane(first!),
    ...(second ? { split: { ...savedPane(second), direction: workspace.split, focused: workspace.focused === 1 } } : {})
  };
  try { localStorage.setItem(TABS_PREFIX + collectionId, JSON.stringify(saved)); }
  catch { /* Reopening tabs is a convenience; without storage the newest note opens. */ }
}
