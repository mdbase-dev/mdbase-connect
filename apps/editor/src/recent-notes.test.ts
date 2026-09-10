import { beforeEach, describe, expect, it } from "vitest";
import { forgetRecentPath, loadRecentPaths, rememberRecentPath } from "./recent-notes";

const KEY = "mdbase-editor:recent-notes";

beforeEach(() => localStorage.clear());

describe("recent note storage", () => {
  it("loads only string paths and bounds persisted history", () => {
    const paths = Array.from({ length: 25 }, (_, index) => `note-${index}.md`);
    localStorage.setItem(KEY, JSON.stringify([null, 42, {}, ...paths]));
    expect(loadRecentPaths()).toEqual(paths.slice(0, 20));
  });

  it("ignores absent, malformed, or non-array history", () => {
    expect(loadRecentPaths()).toEqual([]);
    for (const value of ["{", "null", '{"path":"note.md"}']) {
      localStorage.setItem(KEY, value);
      expect(loadRecentPaths()).toEqual([]);
    }
  });

  it("moves an existing note first and persists at most twenty paths", () => {
    const paths = Array.from({ length: 20 }, (_, index) => `note-${index}.md`);
    const reordered = rememberRecentPath(paths, "note-8.md");
    expect(reordered).toEqual(["note-8.md", ...paths.filter((path) => path !== "note-8.md")]);
    expect(loadRecentPaths()).toEqual(reordered);
    expect(paths[0]).toBe("note-0.md");
    const added = rememberRecentPath(reordered, "new.md");
    expect(added).toEqual(["new.md", ...reordered.slice(0, 19)]);
    expect(loadRecentPaths()).toEqual(added);
  });

  it("forgets a path without changing the remaining order", () => {
    const paths = ["first.md", "removed.md", "last.md"];
    expect(forgetRecentPath(paths, "removed.md")).toEqual(["first.md", "last.md"]);
    expect(loadRecentPaths()).toEqual(["first.md", "last.md"]);
    expect(paths).toEqual(["first.md", "removed.md", "last.md"]);
  });
});
