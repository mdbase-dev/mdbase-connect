import { describe, expect, it, vi } from "vitest";
import type { MdbaseRecordChange } from "@mdbase-dev/connect/advanced";
import { NoteSession, NoteSessionStore, noteRecordAdapter, sessionDirty } from "./note-session";
import type { NoteDocument } from "./model";

function document(path: string, overrides: Partial<NoteDocument> = {}): NoteDocument {
  return {
    path,
    revision: "1",
    body: `# ${path}\n`,
    types: [],
    frontmatter: {},
    effectiveFrontmatter: {},
    file: { path },
    ...overrides
  };
}

function session(note: NoteDocument, update = vi.fn(async (base: NoteDocument, change: MdbaseRecordChange) => ({
  ...base, revision: "2", body: change.body ?? base.body
}))) {
  const gateway = { update, read: vi.fn(), recoverNoteMutation: vi.fn(), pendingNoteMutations: () => [] };
  return { session: new NoteSession(note, () => [], noteRecordAdapter(gateway)), update };
}

describe("note sessions", () => {
  it("derives dirty state from the record session", () => {
    const { session: note } = session(document("one.md"));
    expect(sessionDirty(note)).toBe(false);
    note.edit({ ...note.draft, body: "Changed" });
    expect(sessionDirty(note)).toBe(true);
  });

  it("writes the persisted Markdown for a heading title", async () => {
    const { session: note, update } = session(document("one.md", { body: "# One\n\nBody\n" }));
    note.edit({ ...note.draft, title: "Renamed" });
    await note.record.flush();
    expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ revision: "1" }), { body: "# Renamed\n\nBody\n" });
    expect(note.reproject()).toBe(false);
  });

  it("updates a nested display field without replacing its sibling properties", async () => {
    const profile = { display_name: "Ada Lovelace", timezone: "Europe/London" };
    const { session: note, update } = session(document("People/ada.md", {
      body: "", frontmatter: { profile, kind: "individual" }, effectiveFrontmatter: { profile, kind: "individual" }
    }));
    note.edit({ title: "Augusta Ada King", body: "", source: { kind: "frontmatter", field: "/profile/display_name" } });
    await note.record.flush();
    expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ revision: "1" }), {
      patch: { profile: { display_name: "Augusta Ada King", timezone: "Europe/London" } }
    });
  });

  it("re-derives the draft when a remote version is adopted", () => {
    const { session: note } = session(document("one.md", { body: "# One\n\nBody\n" }));
    note.record.receive(document("one.md", { revision: "9", body: "# Remote\n\nNew body\n" }));
    expect(note.reproject()).toBe(true);
    expect(note.draft).toMatchObject({ title: "Remote", body: "New body\n" });
  });

  it("moves one session identity between paths", () => {
    const store = new NoteSessionStore();
    const { session: note } = session(document("old.md"));
    store.set("old.md", note);
    store.activate(note);
    store.move("old.md", "new.md", note);

    expect(store.get("old.md")).toBeUndefined();
    expect(store.get("new.md")).toBe(note);
    expect(store.active).toBe(note);
  });
});
