import { describe, expect, it, vi } from "vitest";
import { MdbaseError } from "@mdbase-dev/sdk";
import type { MdbaseRecordChange } from "./record-session";
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

function session(note: NoteDocument, update = vi.fn(async (base: NoteDocument, change: MdbaseRecordChange): Promise<NoteDocument> => ({
  ...base, revision: "2", body: change.body ?? base.body
}))) {
  const gateway = { update, read: vi.fn(async () => note), recoverNoteMutation: vi.fn(), pendingNoteMutations: () => [] };
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

  it("saves a body-only edit to a heading-less record without adding a heading", async () => {
    const { session: note, update } = session(document("tasks/20261012150909.md", { body: "", frontmatter: { title: "Task" } }));
    note.edit({ ...note.draft, body: "Editor wrote this body" });
    await note.record.flush();
    expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ revision: "1" }), { body: "Editor wrote this body" });
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

  it.each([true, false])("reconciles a confirmed save with a newer readback (continued typing %s)", async (continued) => {
    const base = document("one.md", { body: "Original" });
    const result = { ...base, revision: "3", body: "Later confirmed edit" };
    let acknowledge!: (record: NoteDocument) => void;
    const update = vi.fn(() => new Promise<NoteDocument>(resolve => { acknowledge = resolve; }));
    const { session: note } = session(base, update);
    note.record.setBody("Submitted");
    const saving = note.record.save();
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    if (continued) note.record.setBody("Typing continued");
    acknowledge(result);
    await saving;
    expect(note.record.snapshot.body).toBe(continued ? "Typing continued" : result.body);
    expect(note.record.snapshot.state).toBe(continued ? "conflict" : "saved");
    expect(note.record.snapshot.remote).toEqual(continued ? result : null);
    expect(update).toHaveBeenCalledOnce();
    note.record.dispose();
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

  it("preserves actionable native validation issues in the record session problem", async () => {
    const update = vi.fn(async () => {
      throw new MdbaseError({
        code: "invalid_record",
        recovery: "fix_request",
        message: "`tasks/one.md` would not be valid",
        issues: [
          {
            code: "schema_required",
            severity: "error",
            message: "required property `dateCreated` is missing",
            details: { location: "/dateCreated", type: "task" }
          },
          {
            code: "schema_enum",
            severity: "error",
            message: "the value is not one of the allowed values",
            details: { location: "/status", type: "task" }
          }
        ]
      });
    });
    const { session: note } = session(document("tasks/one.md", { body: "Body\n", frontmatter: { type: "task" } }), update);
    note.edit({ ...note.draft, body: "Body\nEdited\n" });
    const result = await note.record.save();
    expect(result.ok).toBe(false);
    expect(note.saveState).toBe("error");
    expect(note.record.snapshot.problem?.message).toBe(
      "required property `dateCreated` is missing; status: the value is not one of the allowed values"
    );
  });
});
