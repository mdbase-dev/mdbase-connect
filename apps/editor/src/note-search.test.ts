import { describe, expect, it } from "vitest";
import { buildNoteSearchIndex, searchNotes } from "./note-search";
import type { NoteSummary } from "./model";

const notes: NoteSummary[] = [
  { path: "Projects/Release planning.md", frontmatter: { title: "Ship the editor", tags: ["roadmap"] }, types: ["project"], body: "Prepare the launch." },
  { path: "Reading/Interfaces.md", frontmatter: { title: "Calm interfaces" }, types: ["note"], body: "Good tools leave room." },
  { path: "Journal/Friday.md", frontmatter: { mood: "quiet" }, types: [], body: "A small daily note." }
];

describe("note search", () => {
  const index = buildNoteSearchIndex(notes);

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
});
