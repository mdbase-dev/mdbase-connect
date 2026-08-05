import { describe, expect, it, vi } from "vitest";
import { NoteOperationCoordinator } from "./note-operation-coordinator";
import { createNoteSession } from "./note-session";
import type { NoteDocument } from "./model";

function document(revision = "1"): NoteDocument {
  return {
    path: "note.md",
    revision,
    body: "# Note\n",
    types: [],
    frontmatter: {},
    effectiveFrontmatter: {},
    file: { path: "note.md" }
  };
}

describe("NoteOperationCoordinator", () => {
  it("serializes a newer draft behind an in-flight save", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const update = vi.fn(async (input) => {
      if (update.mock.calls.length === 1) await firstBlocked;
      return { ...document(String(update.mock.calls.length + 1)), body: input.body };
    });
    const session = createNoteSession(document(), []);
    const coordinator = new NoteOperationCoordinator({
      update,
      onSaved: () => undefined,
      onSaveError: () => undefined,
      onChange: () => undefined
    });

    session.draft = { ...session.draft, body: "First" };
    const saving = coordinator.requestSave(session);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    session.draft = { ...session.draft, body: "Second" };
    void coordinator.requestSave(session);
    releaseFirst();
    await saving;

    expect(update.mock.calls.map(([input]) => input.body)).toEqual(["First", "Second"]);
    expect(session.saveState).toBe("saved");
  });
});
