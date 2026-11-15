import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeTab, adjacentTab, changeActiveHistory, closeTab, emptyNoteHistory, emptyWorkspace, forgetInHistory, forgetInWorkspace, historyStep,
  loadWorkspace, openTab, renameInHistory, renameInWorkspace, returnToNote, saveWorkspace, selectTab, tabNote, visitNote, type NoteHistory, type Workspace
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
  return selectTab(workspace, workspace.tabs[0]!.id);
}
const notes = (workspace: Workspace) => workspace.tabs.map(tabNote);

describe("tabs", () => {
  it("opens a new tab beside the active one and makes it active", () => {
    const workspace = openTab(tabsOn("a.md", "b.md"), "c.md");
    expect(notes(workspace)).toEqual(["a.md", "c.md", "b.md"]);
    expect(tabNote(activeTab(workspace))).toBe("c.md");
  });

  it("records navigation in the active tab only", () => {
    const workspace = changeActiveHistory(tabsOn("a.md", "b.md"), (history) => visitNote(history, "c.md"));
    expect(workspace.tabs.map((tab) => tab.history.paths)).toEqual([["a.md", "c.md"], ["b.md"]]);
  });

  it("closes a tab and activates the one to its right, or to its left at the end", () => {
    const workspace = tabsOn("a.md", "b.md", "c.md");
    const [a, b, c] = workspace.tabs;
    expect(tabNote(activeTab(closeTab(workspace, a!.id)))).toBe("b.md");
    expect(tabNote(activeTab(closeTab(selectTab(workspace, c!.id), c!.id)))).toBe("b.md");
    const background = closeTab(workspace, b!.id);
    expect(notes(background)).toEqual(["a.md", "c.md"]);
    expect(background.active).toBe(a!.id);
  });

  it("keeps the last tab open", () => {
    const workspace = tabsOn("a.md");
    expect(closeTab(workspace, workspace.active)).toBe(workspace);
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
    workspace = selectTab(workspace, workspace.tabs[2]!.id);
    workspace = changeActiveHistory(workspace, (history) => visitNote(history, "b.md"));
    workspace = selectTab(workspace, workspace.tabs[0]!.id);
    const forgotten = forgetInWorkspace(workspace, "b.md");
    expect(forgotten.tabs.map((tab) => tab.history)).toEqual([{ paths: ["a.md"], index: 0 }, { paths: ["c.md"], index: 0 }]);
    expect(forgotten.active).toBe(workspace.active);
  });

  it("leaves the active tab open when its only note is deleted", () => {
    const workspace = tabsOn("a.md", "b.md");
    const forgotten = forgetInWorkspace(workspace, "a.md");
    expect(forgotten.tabs.map((tab) => tab.history)).toEqual([emptyNoteHistory, { paths: ["b.md"], index: 0 }]);
  });

  it("moves a background tab forward when the note it was at the start of is deleted", () => {
    let workspace = tabsOn("a.md", "b.md");
    workspace = selectTab(workspace, workspace.tabs[1]!.id);
    workspace = changeActiveHistory(workspace, (history) => returnToNote(visitNote(history, "c.md"), 0, "b.md"));
    workspace = selectTab(workspace, workspace.tabs[0]!.id);
    expect(forgetInWorkspace(workspace, "b.md").tabs[1]!.history).toEqual({ paths: ["c.md"], index: 0 });
  });
});

describe("saved tabs", () => {
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("reopens each collection's tabs and active tab on this device", () => {
    let workspace = changeActiveHistory(tabsOn("a.md", "b.md"), (history) => visitNote(history, "c.md"));
    workspace = selectTab(workspace, workspace.tabs[1]!.id);
    saveWorkspace("one", workspace);
    saveWorkspace("two", tabsOn("d.md"));
    const restored = loadWorkspace("one");
    expect(restored.tabs.map((tab) => tab.history)).toEqual(workspace.tabs.map((tab) => tab.history));
    expect(tabNote(activeTab(restored))).toBe("b.md");
    expect(notes(loadWorkspace("two"))).toEqual(["d.md"]);
    expect(loadWorkspace("three").tabs.map((tab) => tab.history)).toEqual([emptyNoteHistory]);
  });

  it("restores no tabs from a saved value it can't read", () => {
    for (const saved of ["{", "null", JSON.stringify({ tabs: [], active: 0 }), JSON.stringify({ tabs: [{ paths: ["a.md"], index: 3 }], active: 0 })]) {
      localStorage.setItem("mdbase-editor:tabs:one", saved);
      expect(loadWorkspace("one").tabs.map((tab) => tab.history)).toEqual([emptyNoteHistory]);
    }
  });

  it("does without storage the browser refuses", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(() => saveWorkspace("one", tabsOn("a.md"))).not.toThrow();
    expect(loadWorkspace("one").tabs.map((tab) => tab.history)).toEqual([emptyNoteHistory]);
  });
});
