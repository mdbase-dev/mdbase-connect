import { describe, expect, it } from "vitest";
import { folderChangeMoves, readNoteDragPaths } from "./folder-change";

describe("folder changes", () => {
  it("moves a complete subtree without matching similarly named folders", () => {
    expect(folderChangeMoves("Journal", "Archive/Journal", ["Journal/a.md", "Journal/2026/b.md", "Journals/c.md"], [])).toEqual([
      { from: "Journal/a.md", to: "Archive/Journal/a.md" },
      { from: "Journal/2026/b.md", to: "Archive/Journal/2026/b.md" }
    ]);
  });
  it("rejects cycles, traversal, empty segments and collisions before any mutation", () => {
    for (const target of ["Journal/Child", "../Journal", "/Journal", "Archive//Journal", "Journal"]) {
      expect(() => folderChangeMoves("Journal", target, ["Journal/a.md"], [])).toThrow();
    }
    expect(() => folderChangeMoves("Journal", "Archive", ["Journal/a.md", "Archive/a.md"], [])).toThrow("already exists");
    expect(() => folderChangeMoves("Journal", "Archive", ["Journal/a.md", "Archive/b.md"], [])).toThrow("not merged automatically");
  });
  it("blocks attachment-bearing folders rather than silently breaking embeds", () => {
    expect(() => folderChangeMoves("Journal", "Archive", ["Journal/a.md"], ["Journal/Images/a.png"])).toThrow("embedded file references");
  });
  it("validates and deduplicates note drag payloads", () => {
    expect(readNoteDragPaths('["Notes/a.md","Notes/a.md"]')).toEqual(["Notes/a.md"]);
    expect(readNoteDragPaths('["Notes/A.MD"]')).toEqual(["Notes/A.MD"]);
    for (const value of ['not json', '{}', '["../a.md"]', '["/a.md"]', '[1]', '["image.png"]', '[]']) expect(readNoteDragPaths(value)).toEqual([]);
  });
});
