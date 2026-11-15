import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeTab, adjacentTab, changeActiveHistory, closePane, closeTab, emptyNoteHistory, emptyWorkspace, focusedPane, focusPane, forgetInHistory, forgetInWorkspace,
  historyStep, loadWorkspace, openBeside, openTab, paneTab, renameInHistory, renameInWorkspace, returnToNote, saveWorkspace, selectTab, splitPane, tabNote,
  visitNote, type NoteHistory, type Workspace
} from "./workspace";

const visited = (...paths: string[]) => paths.reduce(visitNote, emptyNoteHistory);

describe("note history", () => {
  it("records visits and drops Forward when a new note opens", () => {
    const history = visited("a.md", "b.md", "c.md");
    expect(history).toEqual({ paths: ["a.md", "b.md", "c.md"], index: 2 });
    const back = returnToNote(history, 0, "a.md");
    expect(visitNote(back, "d.md")).toEqual({ paths: ["a.md", "d.md"], index: 1 });
  });

  it("leaves the history unchanged when the current note opens again", () => {
    const history = visited("a.md", "b.md");
    expect(visitNote(history, "b.md")).toBe(history);
  });

  it("keeps the newest hundred visits", () => {
    const history = visited(...Array.from({ length: 105 }, (_, index) => `${index}.md`));
    expect(history.paths).toHaveLength(100);
    expect(history.paths[0]).toBe("5.md");
    expect(history.index).toBe(99);
  });

  it("steps Back and Forward, and stops at either end", () => {
    const history = visited("a.md", "b.md");
    expect(historyStep(history, -1)).toEqual({ path: "a.md", index: 0 });
    expect(historyStep(history, 1)).toBeUndefined();
    expect(historyStep(emptyNoteHistory, -1)).toBeUndefined();
  });

  it("ignores a Back or Forward arrival once the history changed under it", () => {
    const history = visited("a.md", "b.md");
    expect(returnToNote(history, 0, "a.md")).toEqual({ paths: ["a.md", "b.md"], index: 0 });
    expect(returnToNote(history, 0, "renamed.md")).toBe(history);
    expect(returnToNote(history, 5, "a.md")).toBe(history);
  });

  it("follows a rename everywhere the note appears", () => {
    const history = visited("a.md", "b.md", "a.md");
    expect(renameInHistory(history, "a.md", "z.md")).toEqual({ paths: ["z.md", "b.md", "z.md"], index: 2 });
    expect(renameInHistory(history, "missing.md", "z.md")).toBe(history);
  });

  it("forgets a deleted note and keeps the place of the current one", () => {
    const history: NoteHistory = { paths: ["a.md", "gone.md", "b.md", "c.md"], index: 2 };
    expect(forgetInHistory(history, "gone.md")).toEqual({ paths: ["a.md", "b.md", "c.md"], index: 1 });
  });

  it("moves to the visit before a deleted current note", () => {
    expect(forgetInHistory(visited("a.md", "gone.md", "c.md"), "c.md")).toEqual({ paths: ["a.md", "gone.md"], index: 1 });
    expect(forgetInHistory({ paths: ["gone.md", "b.md"], index: 0 }, "gone.md")).toEqual({ paths: ["b.md"], index: -1 });
  });

  it("joins the visits either side of a deleted note when they are the same note", () => {
    const history: NoteHistory = { paths: ["a.md", "gone.md", "a.md", "b.md"], index: 3 };
    expect(forgetInHistory(history, "gone.md")).toEqual({ paths: ["a.md", "b.md"], index: 1 });
    expect(forgetInHistory({ paths: ["a.md", "gone.md", "a.md"], index: 2 }, "gone.md")).toEqual({ paths: ["a.md"], index: 0 });
  });
});

/** A workspace with one tab per path, the first active, as each tab's current note. */
function tabsOn(...paths: string[]): Workspace {
  let workspace = changeActiveHistory(emptyWorkspace(), (history) => visitNote(history, paths[0]!));
  for (const path of paths.slice(1)) workspace = openTab(workspace, path);
  return selectTab(workspace, tabsOf(workspace)[0]!.id);
}
const tabsOf = (workspace: Workspace) => focusedPane(workspace).tabs;
const notes = (workspace: Workspace) => tabsOf(workspace).map(tabNote);
/** Each pane's tabs' current notes. */
const panes = (workspace: Workspace) => workspace.panes.map((pane) => pane.tabs.map(tabNote));

describe("tabs", () => {
  it("opens a new tab beside the active one and makes it active", () => {
    const workspace = openTab(tabsOn("a.md", "b.md"), "c.md");
    expect(notes(workspace)).toEqual(["a.md", "c.md", "b.md"]);
    expect(tabNote(activeTab(workspace))).toBe("c.md");
  });

  it("records navigation in the active tab only", () => {
    const workspace = changeActiveHistory(tabsOn("a.md", "b.md"), (history) => visitNote(history, "c.md"));
    expect(tabsOf(workspace).map((tab) => tab.history.paths)).toEqual([["a.md", "c.md"], ["b.md"]]);
  });

  it("closes a tab and activates the one to its right, or to its left at the end", () => {
    const workspace = tabsOn("a.md", "b.md", "c.md");
    const [a, b, c] = tabsOf(workspace);
    expect(tabNote(activeTab(closeTab(workspace, a!.id)))).toBe("b.md");
    expect(tabNote(activeTab(closeTab(selectTab(workspace, c!.id), c!.id)))).toBe("b.md");
    const background = closeTab(workspace, b!.id);
    expect(notes(background)).toEqual(["a.md", "c.md"]);
    expect(focusedPane(background).active).toBe(a!.id);
  });

  it("keeps the last tab open", () => {
    const workspace = tabsOn("a.md");
    expect(closeTab(workspace, focusedPane(workspace).active)).toBe(workspace);
  });

  it("steps to the next and previous tab, wrapping around", () => {
    const workspace = tabsOn("a.md", "b.md", "c.md");
    expect(tabNote(adjacentTab(workspace, 1))).toBe("b.md");
    expect(tabNote(adjacentTab(workspace, -1))).toBe("c.md");
  });

  it("follows a rename into every tab", () => {
    const workspace = renameInWorkspace(tabsOn("a.md", "b.md", "a.md"), "a.md", "z.md");
    expect(notes(workspace)).toEqual(["z.md", "b.md", "z.md"]);
    expect(renameInWorkspace(workspace, "missing.md", "y.md")).toBe(workspace);
  });

  it("closes background tabs that showed only a deleted note, and takes the others back", () => {
    let workspace = tabsOn("a.md", "b.md", "c.md");
    workspace = selectTab(workspace, tabsOf(workspace)[2]!.id);
    workspace = changeActiveHistory(workspace, (history) => visitNote(history, "b.md"));
    workspace = selectTab(workspace, tabsOf(workspace)[0]!.id);
    const forgotten = forgetInWorkspace(workspace, "b.md");
    expect(tabsOf(forgotten).map((tab) => tab.history)).toEqual([{ paths: ["a.md"], index: 0 }, { paths: ["c.md"], index: 0 }]);
    expect(focusedPane(forgotten).active).toBe(focusedPane(workspace).active);
  });

  it("leaves the active tab open when its only note is deleted", () => {
    const workspace = tabsOn("a.md", "b.md");
    const forgotten = forgetInWorkspace(workspace, "a.md");
    expect(tabsOf(forgotten).map((tab) => tab.history)).toEqual([emptyNoteHistory, { paths: ["b.md"], index: 0 }]);
  });

  it("moves a background tab forward when the note it was at the start of is deleted", () => {
    let workspace = tabsOn("a.md", "b.md");
    workspace = selectTab(workspace, tabsOf(workspace)[1]!.id);
    workspace = changeActiveHistory(workspace, (history) => returnToNote(visitNote(history, "c.md"), 0, "b.md"));
    workspace = selectTab(workspace, tabsOf(workspace)[0]!.id);
    expect(tabsOf(forgetInWorkspace(workspace, "b.md"))[1]!.history).toEqual({ paths: ["c.md"], index: 0 });
  });
});

describe("panes", () => {
  it("splits to the right or down on the current note, and focuses the new pane", () => {
    const workspace = splitPane(tabsOn("a.md", "b.md"), "down", "a.md");
    expect(panes(workspace)).toEqual([["a.md", "b.md"], ["a.md"]]);
    expect(workspace.focused).toBe(1);
    expect(workspace.split).toBe("down");
    expect(splitPane(workspace, "right", "c.md")).toEqual({ ...workspace, split: "right" });
    expect(panes(splitPane(emptyWorkspace(), "right", undefined))).toEqual([[undefined], [undefined]]);
  });

  it("keeps navigation, tabs and history in the focused pane", () => {
    let workspace = splitPane(tabsOn("a.md"), "right", "a.md");
    workspace = changeActiveHistory(openTab(workspace, "b.md"), (history) => visitNote(history, "c.md"));
    expect(panes(workspace)).toEqual([["a.md"], ["a.md", "c.md"]]);
    workspace = focusPane(workspace, 0);
    expect(tabNote(activeTab(workspace))).toBe("a.md");
    expect(tabNote(adjacentTab(workspace, 1))).toBe("a.md");
  });

  it("focuses the pane of a tab it selects", () => {
    const workspace = splitPane(tabsOn("a.md", "b.md"), "right", "c.md");
    const selected = selectTab(workspace, workspace.panes[0]!.tabs[1]!.id);
    expect(selected.focused).toBe(0);
    expect(tabNote(activeTab(selected))).toBe("b.md");
  });

  it("closes a pane with its last tab, and the other pane takes the editor", () => {
    const workspace = splitPane(tabsOn("a.md"), "right", "b.md");
    const closed = closeTab(workspace, paneTab(workspace.panes[1]!).id);
    expect(panes(closed)).toEqual([["a.md"]]);
    expect(closed.focused).toBe(0);
    expect(panes(closeTab(workspace, paneTab(workspace.panes[0]!).id))).toEqual([["b.md"]]);
    expect(panes(closePane(workspace, 0))).toEqual([["b.md"]]);
    expect(closePane(closed, 0)).toBe(closed);
  });

  it("opens a note beside the focused pane", () => {
    const split = openBeside(tabsOn("a.md"), "b.md");
    expect(panes(split)).toEqual([["a.md"], ["b.md"]]);
    expect(split.focused).toBe(1);
    const beside = openBeside(split, "c.md");
    expect(panes(beside)).toEqual([["c.md"], ["b.md"]]);
    expect(beside.focused).toBe(0);
    expect(activeTab(beside).history.paths).toEqual(["a.md", "c.md"]);
  });

  it("follows a rename and a delete into both panes, closing a pane left with nothing to show", () => {
    let workspace = splitPane(tabsOn("a.md"), "right", "b.md");
    workspace = renameInWorkspace(workspace, "b.md", "z.md");
    expect(panes(workspace)).toEqual([["a.md"], ["z.md"]]);
    const background = forgetInWorkspace(focusPane(workspace, 0), "z.md");
    expect(panes(background)).toEqual([["a.md"]]);
    expect(background.focused).toBe(0);
    const focused = forgetInWorkspace(workspace, "z.md");
    expect(focused.panes.map((pane) => pane.tabs.map((tab) => tab.history))).toEqual([[visited("a.md")], [emptyNoteHistory]]);
    expect(focused.focused).toBe(1);
  });

  it("takes the other pane back to the note it showed before a deleted one", () => {
    let workspace = splitPane(tabsOn("a.md"), "right", "b.md");
    workspace = focusPane(changeActiveHistory(workspace, (history) => visitNote(history, "c.md")), 0);
    expect(panes(forgetInWorkspace(workspace, "c.md"))).toEqual([["a.md"], ["b.md"]]);
  });
});

describe("saved tabs", () => {
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("reopens each collection's tabs and active tab on this device", () => {
    let workspace = changeActiveHistory(tabsOn("a.md", "b.md"), (history) => visitNote(history, "c.md"));
    workspace = selectTab(workspace, tabsOf(workspace)[1]!.id);
    saveWorkspace("one", workspace);
    saveWorkspace("two", tabsOn("d.md"));
    const restored = loadWorkspace("one");
    expect(tabsOf(restored).map((tab) => tab.history)).toEqual(tabsOf(workspace).map((tab) => tab.history));
    expect(tabNote(activeTab(restored))).toBe("b.md");
    expect(notes(loadWorkspace("two"))).toEqual(["d.md"]);
    expect(tabsOf(loadWorkspace("three")).map((tab) => tab.history)).toEqual([emptyNoteHistory]);
  });

  it("reopens a split, its direction and the focused pane", () => {
    let workspace = splitPane(tabsOn("a.md", "b.md"), "down", "c.md");
    workspace = focusPane(workspace, 0);
    saveWorkspace("one", workspace);
    const restored = loadWorkspace("one");
    expect(panes(restored)).toEqual([["a.md", "b.md"], ["c.md"]]);
    expect(restored.split).toBe("down");
    expect(restored.focused).toBe(0);
    saveWorkspace("one", closePane(restored, 0));
    expect(panes(loadWorkspace("one"))).toEqual([["c.md"]]);
  });

  it("restores no tabs from a saved value it can't read", () => {
    for (const saved of ["{", "null", JSON.stringify({ tabs: [], active: 0 }), JSON.stringify({ tabs: [{ paths: ["a.md"], index: 3 }], active: 0 }),
      JSON.stringify({ tabs: [{ paths: ["a.md"], index: 0 }], active: 0, split: { tabs: [], active: 0, direction: "right", focused: false } }),
      JSON.stringify({ tabs: [{ paths: ["a.md"], index: 0 }], active: 0, split: { tabs: [{ paths: ["b.md"], index: 0 }], active: 0, direction: "left", focused: false } })]) {
      localStorage.setItem("mdbase-editor:tabs:one", saved);
      expect(tabsOf(loadWorkspace("one")).map((tab) => tab.history)).toEqual([emptyNoteHistory]);
    }
  });

  it("does without storage the browser refuses", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(() => saveWorkspace("one", tabsOn("a.md"))).not.toThrow();
    expect(tabsOf(loadWorkspace("one")).map((tab) => tab.history)).toEqual([emptyNoteHistory]);
  });
});
