import { describe, expect, it } from "vitest";
import {
  editableNote,
  folders,
  noteTags,
  noteTitle,
  persistedBody,
  propertyPatch,
  safeRenamePath,
  tags,
  types
} from "./note";
import type { NoteDocument, NoteSummary } from "./model";

describe("note editing", () => {
  it("keeps a frontmatter title separate from the Markdown body", () => {
    const note = document({ title: "Field title" }, "Body only");
    expect(editableNote(note)).toEqual({
      title: "Field title",
      body: "Body only",
      source: { kind: "frontmatter", field: "title" }
    });
  });

  it("uses and reconstructs the first Markdown heading", () => {
    const editable = editableNote(document({}, "# Heading title\n\nFirst paragraph.\n"));
    expect(editable).toEqual({ title: "Heading title", body: "First paragraph.\n", source: { kind: "heading" } });
    expect(persistedBody("Changed", editable.body, editable.source)).toBe("# Changed\n\nFirst paragraph.\n");
  });

  it("falls back to the filename and promotes it to a heading on save", () => {
    const editable = editableNote({ ...document({}, "Plain body"), path: "Notes/Fallback.md" });
    expect(editable.title).toBe("Fallback");
    expect(persistedBody(editable.title, editable.body, editable.source)).toBe("# Fallback\n\nPlain body");
  });
});

describe("collection helpers", () => {
  it("derives titles and top-level folder counts", () => {
    const notes: NoteSummary[] = [
      summary("Work/a.md", { title: "A" }),
      summary("Work/Deep/b.md", {}),
      summary("Personal/c.md", {})
    ];
    expect(noteTitle(notes[0])).toBe("A");
    expect(folders(notes)).toEqual([
      { name: "Personal", count: 1 },
      { name: "Work", count: 2 }
    ]);
  });

  it("creates null removals for persisted property patches", () => {
    expect(propertyPatch({ keep: 1, remove: true }, { keep: 2, add: "yes" })).toEqual({
      keep: 2,
      remove: null,
      add: "yes"
    });
  });

  it("counts tags and only declared mdbase type facets", () => {
    const notes = [
      summary("Notes/one.md", { tags: ["ideas"] }, ["note"], ["ideas", "inline"]),
      summary("Notes/two.md", { tags: "#ideas" }, ["note", "journal"])
    ];
    expect(noteTags(notes[0])).toEqual(["ideas", "inline"]);
    expect(tags(notes)).toEqual([{ name: "ideas", count: 2 }, { name: "inline", count: 1 }]);
    expect(types(notes, ["note", "person"])).toEqual([
      { name: "note", count: 2 },
      { name: "person", count: 0 }
    ]);
  });

  it("normalizes paths without hiding traversal from the runtime", () => {
    expect(safeRenamePath(" /Folder\\Note.md ")).toBe("Folder/Note.md");
    expect(safeRenamePath("../outside.md")).toBe("../outside.md");
  });
});

function document(frontmatter: Record<string, unknown>, body: string): NoteDocument {
  return {
    path: "Notes/note.md",
    frontmatter,
    effective_frontmatter: structuredClone(frontmatter),
    body,
    types: [],
    revision: "rev-1",
    file: { name: "note.md", folder: "Notes", size: 0, mtime: "" }
  };
}

function summary(path: string, frontmatter: Record<string, unknown>, noteTypes: string[] = [], fileTags: string[] = []): NoteSummary {
  return {
    path,
    frontmatter,
    effective_frontmatter: structuredClone(frontmatter),
    types: noteTypes,
    file: { path, name: path.split("/").at(-1)!, folder: "", size: 0, mtime: "", tags: fileTags }
  };
}
