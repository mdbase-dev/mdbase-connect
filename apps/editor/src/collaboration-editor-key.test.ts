import { describe, expect, it } from "vitest";
import { collaborationEditorKey } from "./collaboration-editor-key";

describe("collaborationEditorKey", () => {
  it("remounts for a reopened room but retains the live editor on terminal failure", () => {
    const retained = new Map<string, string>();

    const opening = collaborationEditorKey(retained, "note-a", true, false);
    const live = collaborationEditorKey(retained, "note-a", true, false, 7);
    expect(opening).not.toBe(live);

    expect(collaborationEditorKey(retained, "note-a", true, true)).toBe(live);
    expect(collaborationEditorKey(retained, "note-b", true, false)).not.toBe(live);

    const reopened = collaborationEditorKey(retained, "note-a", true, false);
    expect(reopened).toBe(opening);
    expect(reopened).not.toBe(live);
    expect(collaborationEditorKey(retained, "note-a", true, false, 7)).toBe(live);
  });
});
