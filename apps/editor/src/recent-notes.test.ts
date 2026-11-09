import { beforeEach, describe, expect, it } from "vitest";
import { forgetRecentPath, loadRecentPaths, rememberRecentPath } from "./recent-notes";

const KEY = "mdbase-editor:recent-notes:one";

beforeEach(() => localStorage.clear());

describe("recent note storage", () => {
  it("loads only string paths and bounds persisted history", () => {
    const paths = Array.from({ length: 25 }, (_, index) => `note-${index}.md`);
    localStorage.setItem(KEY, JSON.stringify([null, 42, {}, ...paths]));
    expect(loadRecentPaths("one")).toEqual(paths.slice(0, 20));
  });

  it("ignores absent, malformed, or non-array history", () => {
    expect(loadRecentPaths("one")).toEqual([]);
    for (const value of ["{", "null", '{"path":"note.md"}']) {
      localStorage.setItem(KEY, value);
      expect(loadRecentPaths("one")).toEqual([]);
    }
  });

  it("keeps each collection's recents apart and retires the shared list", () => {
    localStorage.setItem("mdbase-editor:recent-notes", JSON.stringify(["mixed.md"]));
    localStorage.setItem(KEY, JSON.stringify(["a.md"]));
    localStorage.setItem("mdbase-editor:recent-notes:two", JSON.stringify(["b.md"]));
    expect(loadRecentPaths("one")).toEqual(["a.md"]);
    expect(loadRecentPaths("two")).toEqual(["b.md"]);
    expect(localStorage.getItem("mdbase-editor:recent-notes")).toBeNull();
  });

  it("moves an existing note first and keeps at most twenty paths", () => {
    const paths = Array.from({ length: 20 }, (_, index) => `note-${index}.md`);
    const reordered = rememberRecentPath(paths, "note-8.md");
    expect(reordered).toEqual(["note-8.md", ...paths.filter((path) => path !== "note-8.md")]);
    expect(paths[0]).toBe("note-0.md");
    const added = rememberRecentPath(reordered, "new.md");
    expect(added).toEqual(["new.md", ...reordered.slice(0, 19)]);
  });

  it("forgets a path without changing the remaining order", () => {
    const paths = ["first.md", "removed.md", "last.md"];
    expect(forgetRecentPath(paths, "removed.md")).toEqual(["first.md", "last.md"]);
    expect(paths).toEqual(["first.md", "removed.md", "last.md"]);
  });
});
