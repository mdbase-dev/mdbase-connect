import { describe, expect, it } from "vitest";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  editableNote,
  folderTree,
  noteExcerpt,
  noteHeadings,
  noteTags,
  noteTitle,
  noteWordCount,
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

  it("shows the filename for a heading-less record without writing it unless retitled", () => {
    const editable = editableNote({ ...document({ title: "Owned by another app" }, ""), path: "tasks/20261012150909.md" });
    expect(editable.title).toBe("20261012150909");
    expect(persistedBody(editable.title, "Editor wrote this body", editable.source)).toBe("Editor wrote this body");
    expect(persistedBody("Named", "Editor wrote this body", editable.source)).toBe("# Named\n\nEditor wrote this body");
  });

  it("names opaque UUID files from readable prose without writing the stand-in back", () => {
    const body = "> A recognisable passage.\n\nA separate comment.\n";
    const note = { ...document({}, body), path: "annotations/ann_45007168-741e-4bf3-abfd-5b2a831c15af.md" };
    const editable = editableNote(note);
    expect(noteTitle(note)).toBe("A recognisable passage.");
    expect(editable).toEqual({ title: "A recognisable passage.", body, source: { kind: "path", title: "A recognisable passage." } });
    expect(persistedBody(editable.title, `${body}\nMore notes.`, editable.source)).toBe(`${body}\nMore notes.`);
    expect(noteTitle({ ...note, body: "```\nNot prose\n```\n\n> Readable after code" })).toBe("Readable after code");
    expect(noteTitle({ ...note, body: "![[diagram.png]]" })).toBe("ann_45007168-741e-4bf3-abfd-5b2a831c15af");
    expect(noteTitle({ ...note, path: "Notes/Meaningful name.md" })).toBe("Meaningful name");
    expect(noteTitle({ ...note, body: "# Explicit heading\n\nQuote" })).toBe("Explicit heading");
    expect(noteTitle({ ...note, types: ["note"] }, [titleType])).toBe("ann_45007168-741e-4bf3-abfd-5b2a831c15af");
    const named = { ...note, types: ["note"], effectiveFrontmatter: { title: "Declared name" } };
    expect(noteTitle(named, [titleType])).toBe("Declared name");
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
    expect(folderTree(notes).map(({ name, count }) => ({ name, count }))).toEqual([
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

describe("noteHeadings", () => {
  it("extracts headings with levels and 1-based line numbers", () => {
    const body = "Intro\n\n## Second\n\n### Third level\nText\n# Top level\n";
    expect(noteHeadings(body)).toEqual([
      { level: 2, text: "Second", line: 3 },
      { level: 3, text: "Third level", line: 5 },
      { level: 1, text: "Top level", line: 7 }
    ]);
  });

  it("ignores headings inside fenced code and trims closing hashes", () => {
    const body = "```\n# not a heading\n~~~\n# also not\n```\n## Real #\n";
    expect(noteHeadings(body)).toEqual([{ level: 2, text: "Real", line: 6 }]);
  });

  it("returns nothing for heading-less bodies", () => {
    expect(noteHeadings("Just text.\nMore text.")).toEqual([]);
  });
});

describe("noteWordCount", () => {
  it("counts words while ignoring code, link URLs, and markdown marks", () => {
    const body = [
      "## Heading",
      "",
      "Two words here, and one hyphen-joined word.",
      "",
      "```",
      "ignored code words",
      "```",
      "",
      "A [link label](https://example.com/ignored) and `inline code`.",
      "",
      "- bullet word",
      "> quote word"
    ].join("\n");
    // Heading(1) + Two words here and one hyphen-joined word(7) + A link label and(4)
    // + inline code is skipped + bullet word(2) + quote word(2)
    expect(noteWordCount(body)).toBe(16);
  });

  it("returns zero for empty or whitespace-only bodies", () => {
    expect(noteWordCount("")).toBe(0);
    expect(noteWordCount("  \n \n")).toBe(0);
  });
});

describe("noteExcerpt", () => {
  const excerpt = (body: string, title?: string) => noteExcerpt({ ...summary("Notes/n.md", {}), body: title ? `# ${title}\n\n${body}` : body });

  it("reads the opening prose without Markdown syntax or the title heading", () => {
    expect(excerpt("![[Assets/cover.png]]\n\n- [ ] Plant **tomatoes** near [[Notes/the-fence|the fence]] and [the shed](https://example.com)\n", "Garden notes")).toBe("Plant tomatoes near the fence and the shed");
  });

  it("skips fenced code and rules, and shortens long text on a word boundary", () => {
    expect(excerpt("```js\nconst x = 1;\n```\n---\nAfter the code.")).toBe("After the code.");
    const long = excerpt("word ".repeat(80));
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long).not.toMatch(/wor…$/);
  });

  it("is empty for a body with no prose", () => {
    expect(excerpt("", "Only a title")).toBe("");
  });
});
