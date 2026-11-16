import { autocompletion, completionStatus } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { cycleHeading, exitEmptyQuote, insertNoteLink, toggleBulletList, toggleTask } from "./writing-commands";

/** `¦` marks the caret; two of them mark a selection. */
function editor(source: string) {
  const [anchor, head] = [source.indexOf("¦"), source.indexOf("¦", source.indexOf("¦") + 1)];
  const doc = source.replaceAll("¦", "");
  const selection = head < 0 ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head - 1);
  return new EditorView({
    state: EditorState.create({ doc, selection, extensions: [markdown({ base: markdownLanguage }), autocompletion({ override: [() => null] })] }),
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

describe("exitEmptyQuote", () => {
  it("ends the quote on an empty quoted line, one level at a time", () => {
    const view = editor("> a\n> ¦");
    expect(exitEmptyQuote(view)).toBe(true);
    expect(text(view)).toBe("> a\n");
    expect(view.state.selection.main.head).toBe(4);
    const nested = editor("> > a\n> > ¦");
    exitEmptyQuote(nested);
    expect(text(nested)).toBe("> > a\n> ");
  });

  it("leaves quoted text, a caret before the end and quoted code to the usual Enter", () => {
    expect(exitEmptyQuote(editor("> a¦"))).toBe(false);
    expect(exitEmptyQuote(editor("> a\n>¦ "))).toBe(false);
    expect(exitEmptyQuote(editor("> ```\n> code\n> ¦\n> ```"))).toBe(false);
  });
});
