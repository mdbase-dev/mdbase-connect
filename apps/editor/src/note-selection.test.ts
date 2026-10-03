import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPinnedNotes, savePinnedNotes, selectNote } from "./note-list-view";
import { browserListItems } from "./collection-browser";
import type { CollectionBrowserEntry } from "./collection-browser";

afterEach(() => vi.restoreAllMocks());

describe("note selection", () => {
  const visible = ["a.md", "b.md", "c.md", "d.md"];
  it("toggles without changing the editor anchor and extends/shrinks either direction", () => {
    const single = selectNote({ paths: [] }, "b.md", visible, "single");
    const multiple = selectNote(single, "d.md", visible, "toggle");
    expect(multiple).toEqual({ paths: ["b.md", "d.md"], anchor: "b.md", focus: "d.md" });
    expect(selectNote(multiple, "d.md", visible, "toggle").paths).toEqual(["b.md"]);
    expect(selectNote(multiple, "d.md", visible, "range").paths).toEqual(["b.md", "c.md", "d.md"]);
    expect(selectNote(multiple, "a.md", visible, "range").paths).toEqual(["a.md", "b.md"]);
    expect(selectNote(multiple, "b.md", visible, "range").paths).toEqual(["b.md"]);
  });
  it("starts a new anchor when the old scope isn't visible", () => {
    expect(selectNote({ paths: [], anchor: "hidden.md" }, "c.md", visible, "range"))
      .toEqual({ paths: ["c.md"], anchor: "c.md", focus: "c.md" });
  });
});

describe("collection pins", () => {
  it("persists separately per collection and ignores malformed values", () => {
    savePinnedNotes("one", ["a.md", "b.md"]);
    savePinnedNotes("two", ["c.md"]);
    expect(loadPinnedNotes("one")).toEqual(["a.md", "b.md"]);
    expect(loadPinnedNotes("two")).toEqual(["c.md"]);
    localStorage.setItem("mdbase-editor:pins:one", "bad json");
    expect(loadPinnedNotes("one")).toEqual([]);
    localStorage.setItem("mdbase-editor:pins:one", '[1,"a.md","a.md",null]');
    expect(loadPinnedNotes("one")).toEqual(["a.md"]);
  });
  it("works when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadPinnedNotes("one")).toEqual([]);
    expect(() => savePinnedNotes("one", ["a.md"])).not.toThrow();
  });
  it("groups pinned entries once and never groups search results", () => {
    const entries: CollectionBrowserEntry[] = ["a.md", "b.md"].map((path) => ({ kind: "note", path, note: { path, frontmatter: {}, effectiveFrontmatter: {}, types: [], file: { mtime: "" } } }));
    const pins = new Set(["a.md"]);
    const items = browserListItems(entries, "path-asc", [], undefined, false, pins);
    expect(items.filter((item) => item.kind === "header").map((item) => item.label)).toEqual(["Pinned", "Collection root"]);
    expect(items.filter((item) => item.kind === "entry")).toHaveLength(2);
    expect(browserListItems(entries, "path-asc", [], undefined, true, pins).every((item) => item.kind === "entry")).toBe(true);
  });
});
