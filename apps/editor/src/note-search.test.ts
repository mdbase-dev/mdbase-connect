import { describe, expect, it } from "vitest";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  buildNoteSearchIndex,
  IncrementalNoteSearchIndex,
  searchNoteResults,
  searchNotes,
  searchTextRanges
} from "./note-search";
import type { NoteSummary } from "./model";

const notes: NoteSummary[] = [
  summary("Projects/Release planning.md", { title: "Ship the editor", tags: ["roadmap"] }, ["project"], "Prepare the launch."),
  summary("Reading/Interfaces.md", { title: "Calm interfaces" }, ["note"], "Good tools leave room."),
  summary("Journal/Friday.md", { mood: "quiet" }, [], "A small daily note.")
];

const types: CollectionTypeDescriptor[] = [
  displayType("project"),
  displayType("note")
];

function summary(
  path: string,
  frontmatter: NoteSummary["frontmatter"],
  types: string[],
  body: string
): NoteSummary {
  return {
    path,
    frontmatter,
    effective_frontmatter: structuredClone(frontmatter),
    types,
    body,
    file: {
      path,
      name: path.split("/").at(-1)!,
      folder: path.split("/").slice(0, -1).join("/"),
      size: body.length,
      mtime: ""
    }
  };
}

describe("note search", () => {
  const index = buildNoteSearchIndex(notes, types);

  it("fuzzy-matches titles and paths while ranking titles first", () => {
    expect(searchNotes(index, "shp edt").map((note) => note.path)).toEqual(["Projects/Release planning.md"]);
    expect(searchNotes(index, "interfaces")[0].path).toBe("Reading/Interfaces.md");
  });

  it("searches tags, types, frontmatter, and body content", () => {
    expect(searchNotes(index, "roadmap")[0].path).toBe("Projects/Release planning.md");
    expect(searchNotes(index, "quiet").map((note) => note.path)).toContain("Journal/Friday.md");
    expect(searchNotes(index, "leave room")[0].path).toBe("Reading/Interfaces.md");
  });

  it("preserves collection order for an empty query", () => {
    expect(searchNotes(index, "")).toEqual(notes);
  });

  it("reuses normalized entries until a note changes", () => {
    const incremental = new IncrementalNoteSearchIndex();
    const first = incremental.build(notes, types);
    const unchanged = incremental.build([...notes], types);
    const changedNote = { ...notes[1], body: "Changed body" };
    const changed = incremental.build([notes[0], changedNote, notes[2]], types);

    expect(unchanged[0]).toBe(first[0]);
    expect(changed[0]).toBe(first[0]);
    expect(changed[1]).not.toBe(first[1]);
  });

  it("returns a highlighted excerpt from the field that matched", () => {
    const [bodyResult] = searchNoteResults(index, "leave room");
    expect(bodyResult.note.path).toBe("Reading/Interfaces.md");
    expect(bodyResult.context).toMatchObject({
      kind: "body",
      text: "Good tools leave room."
    });
    expect(bodyResult.context.ranges.map((range) =>
      bodyResult.context.text.slice(range.from, range.to)
    )).toEqual(["leave", "room"]);

    const [metadataResult] = searchNoteResults(index, "roadmap");
    expect(metadataResult.context.kind).toBe("metadata");
    expect(metadataResult.context.text).toContain("#roadmap");
  });

  it("finds every non-overlapping literal search token for quiet highlighting", () => {
    expect(searchTextRanges("Alpha beta alpha", "alpha beta")).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 10 },
      { from: 11, to: 16 }
    ]);
  });
});

function displayType(name: string): CollectionTypeDescriptor {
  return {
    name,
    definition: {},
    collection: { display: { name_field: "title" } },
    schema: { type: "object", properties: { title: { type: "string" } } },
    extensions: {}
  };
}
