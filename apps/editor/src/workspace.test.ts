import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyNoteHistory, forgetInHistory, historyStep, lastOpenNote, rememberOpenNote, renameInHistory, returnToNote, visitNote, type NoteHistory } from "./workspace";

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

describe("last open note", () => {
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("remembers the open note for each collection", () => {
    rememberOpenNote("one", "a.md");
    rememberOpenNote("two", "b.md");
    expect(lastOpenNote("one")).toBe("a.md");
    expect(lastOpenNote("two")).toBe("b.md");
    expect(lastOpenNote("three")).toBeUndefined();
  });

  it("does without storage the browser refuses", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(() => rememberOpenNote("one", "a.md")).not.toThrow();
    expect(lastOpenNote("one")).toBeUndefined();
  });
});
