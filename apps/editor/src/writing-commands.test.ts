import { autocompletion, completionStatus } from "@codemirror/autocomplete";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { cycleHeading, insertNoteLink, toggleBulletList, toggleTask } from "./writing-commands";

/** `¦` marks the caret; two of them mark a selection. */
function editor(source: string) {
  const [anchor, head] = [source.indexOf("¦"), source.indexOf("¦", source.indexOf("¦") + 1)];
  const doc = source.replaceAll("¦", "");
  const selection = head < 0 ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head - 1);
  return new EditorView({
    state: EditorState.create({ doc, selection, extensions: autocompletion({ override: [() => null] }) }),
    parent: document.body
  });
}

const text = (view: EditorView) => view.state.doc.toString();

describe("touch formatting commands", () => {
  it("cycles a line through two heading levels and back to text", () => {
    const view = editor("Plan¦");
    cycleHeading(view);
    expect(text(view)).toBe("## Plan");
    cycleHeading(view);
    expect(text(view)).toBe("### Plan");
    cycleHeading(view);
    expect(text(view)).toBe("Plan");
  });

  it("toggles every selected line as a list, keeping indentation", () => {
    const view = editor("¦one\n  two¦");
    toggleBulletList(view);
    expect(text(view)).toBe("- one\n  - two");
    toggleBulletList(view);
    expect(text(view)).toBe("one\n  two");
  });

  it("turns lines and list items into tasks and back, keeping done ones done", () => {
    const view = editor("¦- one\n- [x] two\nthree¦");
    toggleTask(view);
    expect(text(view)).toBe("- [ ] one\n- [x] two\n- [ ] three");
    toggleTask(view);
    expect(text(view)).toBe("one\ntwo\nthree");
  });

  it("wraps a selection as a note link, or starts one and offers notes", () => {
    const selected = editor("See ¦Plan¦ now");
    insertNoteLink(selected);
    expect(text(selected)).toBe("See [[Plan]] now");
    const empty = editor("See ¦");
    insertNoteLink(empty);
    expect(text(empty)).toBe("See [[");
    expect(empty.state.selection.main.head).toBe(6);
    expect(completionStatus(empty.state)).not.toBeNull();
  });
});
