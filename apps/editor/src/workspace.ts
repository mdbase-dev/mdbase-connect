import {
  apply, emptyWorkspace as emptyLayout, findStack, fromSnapshot, mainStacks, stackOfPanel, toSnapshot, WorkspaceStore,
  type Operation, type PanelData, type PanelDescriptor, type SplitSide, type StackNode, type WorkspaceState
} from "@mdbase-dev/panels";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

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

/** Where a new pane opens: beside the focused one, or under it. */
export type SplitDirection = "right" | "down";

/** The editor's panes, in reading order, and the one its commands act in. `layout` is the arrangement
 * they are read from: every tab is a panel of the panel workspace, and every pane one of its stacks. */
export interface Workspace {
  readonly layout: WorkspaceState;
  readonly panes: readonly Pane[];
  readonly focused: number;
}

const NOTE = "note";
let tabCount = 0;

function isHistory(value: unknown): value is NoteHistory {
  if (typeof value !== "object" || value === null) return false;
  const { paths, index } = value as Partial<NoteHistory>;
  return Array.isArray(paths) && paths.every((path) => typeof path === "string")
    && Number.isInteger(index) && index! >= -1 && index! < paths.length;
}

function historyOf(panel: PanelDescriptor | undefined): NoteHistory {
  return isHistory(panel?.data) ? panel.data : emptyNoteHistory;
}

function historyData(history: NoteHistory): PanelData {
  return { paths: history.paths, index: history.index };
}

function newPanel(layout: WorkspaceState, history: NoteHistory): PanelDescriptor {
  let id: string;
  do id = `tab-${++tabCount}`; while (Object.hasOwn(layout.panels, id));
  return { id, kind: NOTE, data: historyData(history) };
}

const views = new WeakMap<WorkspaceState, Workspace>();

/** The editor's reading of an arrangement. The same arrangement always gives the same object. */
export function workspaceOf(layout: WorkspaceState): Workspace {
  const known = views.get(layout);
  if (known) return known;
  const stacks = mainStacks(layout);
  const panes = stacks.map((stack): Pane => ({
    id: stack.id,
    tabs: stack.panels.map((id) => ({ id, history: historyOf(layout.panels[id]) })),
    active: stack.active ?? stack.panels[0]!
  }));
  const leading = layout.leader ? stackOfPanel(layout, layout.leader)?.id : undefined;
  const focused = [layout.focus, leading].map((id) => stacks.findIndex((stack) => stack.id === id)).find((index) => index >= 0) ?? 0;
  const workspace = { layout, panes, focused };
  views.set(layout, workspace);
  return workspace;
}

function change(workspace: Workspace, ...operations: Operation[]): Workspace {
  return workspaceOf(operations.reduce(apply, workspace.layout));
}

export function emptyWorkspace(): Workspace {
  const layout = emptyLayout();
  return workspaceOf(apply(layout, { type: "add", panel: newPanel(layout, emptyNoteHistory) }));
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

/** The notes shown by the panes without the focus, each once. */
export function backgroundNotes(workspace: Workspace): string[] {
  return [...new Set(workspace.panes.flatMap((pane, index) => index === workspace.focused ? [] : tabNote(paneTab(pane)) ?? []))];
}

function setHistory(tab: NoteTab, history: NoteHistory): Operation[] {
  return history === tab.history ? [] : [{ type: "update", panel: tab.id, changes: { data: historyData(history) } }];
}

export function changeActiveHistory(workspace: Workspace, changeHistory: (history: NoteHistory) => NoteHistory): Workspace {
  const tab = activeTab(workspace);
  return change(workspace, ...setHistory(tab, changeHistory(tab.history)));
}

/** A new tab opens on `path` beside the active one in the focused pane, and becomes active. */
export function openTab(workspace: Workspace, path: string): Workspace {
  const pane = focusedPane(workspace);
  const index = pane.tabs.indexOf(paneTab(pane)) + 1;
  return change(workspace, { type: "add", panel: newPanel(workspace.layout, visitNote(emptyNoteHistory, path)), target: { at: "stack", stack: pane.id, index } },
    { type: "focus", stack: pane.id });
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
  const heir = pane.tabs[at + 1] ?? pane.tabs[at - 1]!;
  return change(workspace, { type: "remove", panel: id }, ...(id === pane.active ? [{ type: "activate", panel: heir.id } as const] : []),
    { type: "focus", stack: focusedPane(workspace).id });
}

/** Shows a tab, and focuses the pane it is in. */
export function selectTab(workspace: Workspace, id: string): Workspace {
  const index = paneOf(workspace, id);
  if (index < 0) return workspace;
  return change(workspace, { type: "activate", panel: id }, { type: "focus", stack: workspace.panes[index]!.id });
}

/** The next (1) or previous (-1) tab in the focused pane, wrapping around at either end. */
export function adjacentTab(workspace: Workspace, direction: -1 | 1): NoteTab {
  const { tabs } = focusedPane(workspace);
  const at = tabs.indexOf(activeTab(workspace));
  return tabs[(at + direction + tabs.length) % tabs.length]!;
}

const SIDE: Record<SplitDirection, SplitSide> = { right: "right", down: "bottom" };

/** Opens a pane on `path` to the right of the given (or focused) pane, or under it, and focuses it. */
export function splitPane(workspace: Workspace, direction: SplitDirection, path: string | undefined, stackId = focusedPane(workspace).id): Workspace {
  const panel = newPanel(workspace.layout, path === undefined ? emptyNoteHistory : visitNote(emptyNoteHistory, path));
  const opened = apply(workspace.layout, { type: "add", panel, target: { at: "split", stack: stackId, side: SIDE[direction] } });
  return workspaceOf(apply(opened, { type: "focus", stack: stackOfPanel(opened, panel.id)!.id }));
}

export function focusPane(workspace: Workspace, index: number): Workspace {
  const pane = workspace.panes[index];
  return !pane || index === workspace.focused ? workspace : change(workspace, { type: "focus", stack: pane.id });
}

/** The pane after the focused one in reading order, or the first after the last. */
export function nextPane(workspace: Workspace): number {
  return (workspace.focused + 1) % workspace.panes.length;
}

/** Closes a pane and its tabs. The focus stays where it was, or goes to the pane that takes a closed
 * focused pane's place. The only pane stays. */
export function closePane(workspace: Workspace, index: number): Workspace {
  const pane = workspace.panes[index];
  if (workspace.panes.length === 1 || !pane) return workspace;
  const heir = index === workspace.focused ? workspace.panes[index + 1] ?? workspace.panes[index - 1]! : focusedPane(workspace);
  return change(workspace, ...pane.tabs.map((tab) => ({ type: "remove", panel: tab.id }) as const), { type: "focus", stack: heir.id });
}

/** Opens `path` in the pane after the focused one, splitting to the right when there is one pane, and focuses it. */
export function openBeside(workspace: Workspace, path: string): Workspace {
  if (workspace.panes.length === 1) return splitPane(workspace, "right", path);
  return changeActiveHistory(focusPane(workspace, nextPane(workspace)), (history) => visitNote(history, path));
}

function everyTab(workspace: Workspace): NoteTab[] {
  return workspace.panes.flatMap((pane) => pane.tabs);
}

export function renameInWorkspace(workspace: Workspace, from: string, to: string): Workspace {
  return change(workspace, ...everyTab(workspace).flatMap((tab) => setHistory(tab, renameInHistory(tab.history, from, to))));
}

/** A deleted note leaves every tab. Any tab but the focused one goes back to the note it showed before,
 * or closes when it showed no other, and a pane left without tabs closes; the focused tab's caller opens
 * the next note in it. */
export function forgetInWorkspace(workspace: Workspace, path: string): Workspace {
  const focusedTab = activeTab(workspace);
  const operations = workspace.panes.flatMap((pane) => {
    const closing = new Set<string>();
    const changes = pane.tabs.flatMap((tab): Operation[] => {
      const history = forgetInHistory(tab.history, path);
      if (tab === focusedTab) return setHistory(tab, history);
      if (!history.paths.length) {
        closing.add(tab.id);
        return [{ type: "remove", panel: tab.id }];
      }
      return setHistory(tab, history.index < 0 ? { paths: history.paths, index: 0 } : history);
    });
    if (!closing.has(pane.active)) return changes;
    const kept = pane.tabs.filter((tab) => !closing.has(tab.id));
    const before = pane.tabs.slice(0, pane.tabs.findIndex((tab) => tab.id === pane.active)).filter((tab) => !closing.has(tab.id)).length;
    const heir = kept[Math.min(before, kept.length - 1)];
    return heir ? [...changes, { type: "activate", panel: heir.id } as const] : changes;
  });
  return change(workspace, ...operations, { type: "focus", stack: focusedPane(workspace).id });
}

/** The editor's panel workspace: the arrangement as rendered, the latest one for callbacks that run
 * between renders, and the store the panels are drawn from. `changeWorkspace` is the editor's own change;
 * `onUserChange` hears the changes made in the panel workspace itself (a tab clicked, dragged or closed). */
export function useWorkspace() {
  const [store] = useState(() => new WorkspaceStore({ initial: emptyWorkspace().layout }));
  const layout = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const latest = useMemo(() => ({ get current() { return workspaceOf(store.getState()); } }), [store]);
  const [own] = useState(() => ({ changing: false }));
  const changeWorkspace = useCallback((changeIt: (current: Workspace) => Workspace) => {
    const next = changeIt(workspaceOf(store.getState()));
    if (next.layout === store.getState()) return;
    own.changing = true;
    try { store.dispatch({ type: "load", state: next.layout }, { history: "skip" }); }
    finally { own.changing = false; }
  }, [own, store]);
  const onUserChange = useCallback((heard: (previous: Workspace, next: Workspace) => void) => store.subscribe(({ previous, state }) => {
    if (!own.changing) heard(workspaceOf(previous), workspaceOf(state));
  }), [own, store]);
  return { workspace: workspaceOf(layout), latest, changeWorkspace, onUserChange, store };
}

const PANELS_PREFIX = "mdbase-editor:panels:";
/** Where tabs were saved before the panel workspace: one pane's tabs, and a second pane's when split. */
const TABS_PREFIX = "mdbase-editor:tabs:";

interface SavedPane {
  tabs: NoteHistory[];
  active: number;
}

interface SavedWorkspace extends SavedPane {
  split?: SavedPane & { direction: SplitDirection; focused: boolean };
}

function isSavedPane(value: unknown): value is SavedPane {
  if (typeof value !== "object" || value === null) return false;
  const { tabs, active } = value as Partial<SavedPane>;
  return Array.isArray(tabs) && tabs.length > 0 && Number.isInteger(active) && active! >= 0 && active! < tabs.length && tabs.every(isHistory);
}

function isSavedWorkspace(value: unknown): value is SavedWorkspace {
  if (!isSavedPane(value)) return false;
  const { split } = value as SavedWorkspace;
  return split === undefined || isSavedPane(split) && (split.direction === "right" || split.direction === "down") && typeof split.focused === "boolean";
}

/** Fills a pane with saved tabs: the first replaces the pane's one empty tab. */
function restoreTabs(workspace: Workspace, pane: Pane, { tabs, active }: SavedPane): Workspace {
  let layout = workspace.layout;
  const ids = tabs.map((history, index) => {
    if (index === 0) {
      layout = apply(layout, { type: "update", panel: pane.tabs[0]!.id, changes: { data: historyData(history) } });
      return pane.tabs[0]!.id;
    }
    const panel = newPanel(layout, history);
    layout = apply(layout, { type: "add", panel, target: { at: "stack", stack: pane.id }, activate: false });
    return panel.id;
  });
  return workspaceOf(apply(layout, { type: "activate", panel: ids[active]! }));
}

function restoreSavedTabs(saved: SavedWorkspace): Workspace {
  const first = emptyWorkspace();
  const one = restoreTabs(first, first.panes[0]!, saved);
  if (!saved.split) return one;
  const two = splitPane(one, saved.split.direction, undefined);
  const restored = restoreTabs(two, two.panes[1]!, saved.split);
  return focusPane(workspaceOf(restored.layout), saved.split.focused ? 1 : 0);
}

/** An arrangement the editor can show: every pane holds note tabs, and a pane has the focus. */
function restoreLayout(value: unknown): Workspace | undefined {
  const layout = fromSnapshot(value);
  const stacks = mainStacks(layout);
  const usable = (stack: StackNode) => stack.panels.every((id) => layout.panels[id]?.kind === NOTE && isHistory(layout.panels[id].data));
  if (!stacks.length || !stacks.every(usable)) return undefined;
  return workspaceOf(findStack(layout, layout.focus) ? layout : apply(layout, { type: "focus", stack: stacks[0]!.id }));
}

/** The panes and tabs this device had open in the collection, or one empty tab when it had none or can't say. */
export function loadWorkspace(collectionId: string): Workspace {
  try {
    const arrangement = localStorage.getItem(PANELS_PREFIX + collectionId);
    if (arrangement) {
      const restored = restoreLayout(JSON.parse(arrangement));
      if (restored) return restored;
    }
  } catch { /* An arrangement that can't be read falls back to the tabs saved before it, then to none. */ }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(TABS_PREFIX + collectionId) ?? "null");
    if (isSavedWorkspace(saved)) return restoreSavedTabs(saved);
  } catch { /* Unreadable storage restores no tabs. */ }
  return emptyWorkspace();
}

export function saveWorkspace(collectionId: string, workspace: Workspace): void {
  try { localStorage.setItem(PANELS_PREFIX + collectionId, JSON.stringify(toSnapshot(workspace.layout))); }
  catch { /* Reopening tabs is a convenience; without storage the newest note opens. */ }
}
