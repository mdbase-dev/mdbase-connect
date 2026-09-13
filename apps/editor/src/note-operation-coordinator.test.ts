import { describe, expect, it, vi } from "vitest";
import { NoteOperationCoordinator } from "./note-operation-coordinator";
import { MdbaseConnectError } from "@mdbase-dev/connect";
import { connectProblem } from "@mdbase-dev/connect-testing";
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
  it("recovers the original autosave snapshot before saving changed input", async () => {
    const unknown = new MdbaseConnectError(connectProblem("operation_outcome_unknown", "Response lost", {
      operationOutcome: "unknown", details: { request_id: "original-update" }
    }));
    const update = vi.fn(async (input) => {
      if (update.mock.calls.length === 1) throw unknown;
      return { ...document("3"), body: input.body };
    });
    const recover = vi.fn(async () => ({ ...document("2"), body: "First" }));
    const session = createNoteSession(document(), []);
    const coordinator = new NoteOperationCoordinator({ update, recover, onSaved() {}, onSaveError() {}, onChange() {} });
    session.draft.body = "First";
    await expect(coordinator.requestSave(session)).rejects.toBe(unknown);
    expect(session.saveState).toBe("recovery");
    session.draft.body = "Second";
    session.remoteDocument = { ...document("2"), body: "First" };
    await coordinator.requestSave(session);
    expect(recover).toHaveBeenCalledExactlyOnceWith("original-update");
    expect(update).toHaveBeenCalledTimes(1);
    expect(session.persistedDraft.body).toBe("First");
    expect(session.draft.body).toBe("Second");
    expect(session.remoteDocument).toBeUndefined();
    await coordinator.flush(session);
    expect(update.mock.calls[1][0]).toMatchObject({ revision: "2", body: "Second" });
    expect(session.saveState).toBe("saved");
  });

  it("failed recovery retains the pending identity and never calls update again", async () => {
    const unknown = new MdbaseConnectError(connectProblem("operation_outcome_unknown", "Response lost", {
      operationOutcome: "unknown", details: { request_id: "original-update" }
    }));
    const update = vi.fn(async () => { throw unknown; });
    const recover = vi.fn(async () => { throw new Error("offline"); });
    const session = createNoteSession(document(), []);
    session.draft.body = "Accepted";
    const coordinator = new NoteOperationCoordinator({ update, recover, onSaved() {}, onSaveError() {}, onChange() {} });
    await expect(coordinator.requestSave(session)).rejects.toBe(unknown);
    for (let i = 0; i < 2; i++) await expect(coordinator.requestSave(session)).rejects.toThrow("offline");
    expect(update).toHaveBeenCalledTimes(1);
    expect(session.pendingSave).toMatchObject({ requestId: "original-update", draft: { body: "Accepted" } });
    expect(session.saveState).toBe("recovery");
  });
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
