import { describe, expect, it } from "vitest";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { NoteSummary } from "./model";
import {
  defaultNoteSort,
  loadNoteSort,
  moveListIndex,
  saveNoteSort,
  sortNotes
} from "./note-list-view";

describe("note list view", () => {
  const types = [displayType("note")];
  const notes = [
    note("Archive/Zebra.md", "Zebra", "2026-01-03T00:00:00.000Z"),
    note("Notes/alpha-10.md", "Alpha 10", "2026-01-01T00:00:00.000Z"),
    note("Notes/alpha-2.md", "Alpha 2", "2026-01-02T00:00:00.000Z"),
    note("Inbox/Undated.md", "Undated", "")
  ];

  it("sorts notes by modified time, title, and path without moving undated notes above dated notes", () => {
    expect(paths(sortNotes(notes, "modified-desc", types))).toEqual([
      "Archive/Zebra.md",
      "Notes/alpha-2.md",
      "Notes/alpha-10.md",
      "Inbox/Undated.md"
    ]);
    expect(paths(sortNotes(notes, "modified-asc", types))).toEqual([
      "Notes/alpha-10.md",
      "Notes/alpha-2.md",
      "Archive/Zebra.md",
      "Inbox/Undated.md"
    ]);
    expect(paths(sortNotes(notes, "title-asc", types))).toEqual([
      "Notes/alpha-2.md",
      "Notes/alpha-10.md",
      "Inbox/Undated.md",
      "Archive/Zebra.md"
    ]);
    expect(paths(sortNotes(notes, "path-asc", types))).toEqual([
      "Archive/Zebra.md",
      "Inbox/Undated.md",
      "Notes/alpha-2.md",
      "Notes/alpha-10.md"
    ]);
    expect(paths(notes)).toEqual([
      "Archive/Zebra.md",
      "Notes/alpha-10.md",
      "Notes/alpha-2.md",
      "Inbox/Undated.md"
    ]);
  });

  it("persists a valid sort preference and repairs unsupported values", () => {
    expect(loadNoteSort()).toBe(defaultNoteSort);
    saveNoteSort("title-asc");
    expect(loadNoteSort()).toBe("title-asc");

    localStorage.setItem("mdbase-editor:note-sort", "random");
    expect(loadNoteSort()).toBe(defaultNoteSort);
  });
});

function note(path: string, title: string, mtime: string): NoteSummary {
  return {
    path,
    frontmatter: {},
    effectiveFrontmatter: { title },
    types: ["note"],
    file: {
      path,
      name: path.split("/").at(-1)!,
      folder: path.split("/").slice(0, -1).join("/"),
      size: 0,
      mtime
    }
  } as NoteSummary;
}

function displayType(name: string): CollectionTypeDescriptor {
  return {
    name,
    definition: {},
    collection: { display: { name_field: "title" } },
    schema: { type: "object", properties: { title: { type: "string" } } },
    extensions: {}
  };
}

function paths(notes: NoteSummary[]): string[] {
  return notes.map((note) => note.path);
}

describe("moveListIndex", () => {
  it("moves by one, jumps to bounds, and pages", () => {
    expect(moveListIndex(-1, 5, "ArrowDown")).toBe(0);
    expect(moveListIndex(0, 5, "ArrowDown")).toBe(1);
    expect(moveListIndex(4, 5, "ArrowDown")).toBe(4);
    expect(moveListIndex(4, 5, "ArrowUp")).toBe(3);
    expect(moveListIndex(0, 5, "ArrowUp")).toBe(0);
    expect(moveListIndex(2, 5, "Home")).toBe(0);
    expect(moveListIndex(2, 5, "End")).toBe(4);
    expect(moveListIndex(0, 25, "PageDown")).toBe(10);
    expect(moveListIndex(20, 25, "PageDown")).toBe(24);
    expect(moveListIndex(22, 25, "PageUp")).toBe(12);
    expect(moveListIndex(1, 25, "PageUp")).toBe(0);
  });

  it("handles empty and out-of-range inputs", () => {
    expect(moveListIndex(0, 0, "ArrowDown")).toBe(-1);
    expect(moveListIndex(99, 3, "ArrowDown")).toBe(3 - 1);
    expect(moveListIndex(-9, 3, "ArrowUp")).toBe(0);
  });
});
