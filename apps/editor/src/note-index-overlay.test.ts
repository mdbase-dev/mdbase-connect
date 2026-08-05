import { describe, expect, it } from "vitest";
import { NoteIndexOverlay } from "./note-index-overlay";
import type { NoteSummary } from "./model";

function note(path: string, body = path): NoteSummary {
  return {
    path,
    body,
    types: [],
    frontmatter: {},
    effectiveFrontmatter: {},
    file: { path }
  };
}

describe("NoteIndexOverlay", () => {
  it("does not resurrect a deleted note from a stale snapshot", () => {
    const overlay = new NoteIndexOverlay();
    overlay.remove("deleted.md");

    expect(overlay.apply([note("kept.md"), note("deleted.md")]).map((item) => item.path))
      .toEqual(["kept.md"]);
  });

  it("replaces an old rename path and keeps the accepted document", () => {
    const overlay = new NoteIndexOverlay();
    overlay.upsert(note("new.md", "current"), "old.md");

    expect(overlay.apply([note("old.md", "stale")]))
      .toEqual([note("new.md", "current")]);
  });

  it("prefers a locally accepted update over older hydrated content", () => {
    const overlay = new NoteIndexOverlay();
    overlay.upsert(note("note.md", "current"));

    expect(overlay.apply([note("note.md", "stale")])[0]?.body).toBe("current");
  });
});
