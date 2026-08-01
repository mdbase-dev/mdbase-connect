import { describe, expect, it } from "vitest";
import { createNoteSession, NoteSessionStore, sessionDirty } from "./note-session";
import type { NoteDocument } from "./model";

function document(path: string): NoteDocument {
  return {
    path,
    revision: "1",
    body: `# ${path}\n`,
    types: [],
    frontmatter: {},
    effective_frontmatter: {},
    file: { path }
  };
}

describe("note sessions", () => {
  it("derives dirty state from the persisted draft", () => {
    const session = createNoteSession(document("one.md"), []);
    expect(sessionDirty(session)).toBe(false);
    session.draft = { ...session.draft, body: "Changed" };
    expect(sessionDirty(session)).toBe(true);
  });

  it("moves one session identity between paths", () => {
    const store = new NoteSessionStore();
    const session = store.create(document("old.md"), []);
    store.activate(session);
    store.move("old.md", "new.md", session);

    expect(store.get("old.md")).toBeUndefined();
    expect(store.get("new.md")).toBe(session);
    expect(store.active).toBe(session);
  });
});
