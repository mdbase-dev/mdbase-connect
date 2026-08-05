import { describe, expect, it } from "vitest";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  editableNote,
  folderTree,
  folders,
  noteTags,
  noteTitle,
  persistedBody,
  propertyPatch,
  safeRenamePath,
  tags,
  types
} from "./note";
import { fieldReferencePatch } from "./field-reference";
import type { NoteDocument, NoteSummary } from "./model";

describe("note editing", () => {
  it("keeps a frontmatter title separate from the Markdown body", () => {
    const note = document({ title: "Field title" }, "Body only", ["note"]);
    expect(editableNote(note, [titleType])).toEqual({
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

  it("reads and safely patches a nested declared display field", () => {
    const frontmatter = {
      profile: { display_name: "Ada Lovelace", timezone: "Europe/London" },
      category: "person"
    };
    const note = document(frontmatter, "Body only", ["contact"]);

    expect(editableNote(note, [contactType])).toEqual({
      title: "Ada Lovelace",
      body: "Body only",
      source: { kind: "frontmatter", field: "/profile/display_name" }
    });
    expect(fieldReferencePatch(frontmatter, "/profile/display_name", "Grace Hopper")).toEqual({
      profile: { display_name: "Grace Hopper", timezone: "Europe/London" }
    });
  });

  it("keeps a missing declared display field authoritative", () => {
    const note = document({}, "# Visible heading\n\nBody only", ["note"]);

    expect(editableNote(note, [titleType])).toEqual({
      title: "Visible heading",
      body: "# Visible heading\n\nBody only",
      source: { kind: "frontmatter", field: "title" }
    });
  });
});

describe("collection helpers", () => {
  it("derives titles and top-level folder counts", () => {
    const notes: NoteSummary[] = [
      summary("Work/a.md", { title: "A" }, ["note"]),
      summary("Work/Deep/b.md", {}),
      summary("Personal/c.md", {})
    ];
    expect(noteTitle(notes[0], [titleType])).toBe("A");
    expect(folders(notes)).toEqual([
      { name: "Personal", count: 1 },
      { name: "Work", count: 2 }
    ]);
    expect(folderTree(notes)).toEqual([
      { name: "Personal", path: "Personal", count: 1, children: [] },
      {
        name: "Work",
        path: "Work",
        count: 2,
        children: [
          { name: "Deep", path: "Work/Deep", count: 1, children: [] }
        ]
      }
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

function document(frontmatter: Record<string, unknown>, body: string, noteTypes: string[] = []): NoteDocument {
  return {
    path: "Notes/note.md",
    frontmatter,
    effectiveFrontmatter: structuredClone(frontmatter),
    body,
    types: noteTypes,
    revision: "rev-1",
    file: { name: "note.md", folder: "Notes", size: 0, mtime: "" }
  };
}

const titleType: CollectionTypeDescriptor = {
  name: "note",
  definition: {},
  collection: { display: { name_field: "title" } },
  schema: { type: "object", properties: { title: { type: "string" } } },
  extensions: {}
};

const contactType: CollectionTypeDescriptor = {
  name: "contact",
  definition: {},
  collection: { display: { name_field: "/profile/display_name" } },
  schema: {
    type: "object",
    properties: {
      profile: {
        type: "object",
        properties: {
          display_name: { type: "string" },
          timezone: { type: "string" }
        }
      }
    }
  },
  extensions: {}
};

function summary(path: string, frontmatter: Record<string, unknown>, noteTypes: string[] = [], fileTags: string[] = []): NoteSummary {
  return {
    path,
    frontmatter,
    effectiveFrontmatter: structuredClone(frontmatter),
    types: noteTypes,
    file: { path, name: path.split("/").at(-1)!, folder: "", size: 0, mtime: "", tags: fileTags }
  };
}
