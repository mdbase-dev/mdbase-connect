import { autocompletion, completionStatus } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { cycleHeading, exitEmptyQuote, insertNoteLink, toggleBulletList, toggleTask, wrapSelectionOnType } from "./writing-commands";

/** `¦` marks the caret; two of them mark a selection. */
function editor(source: string, extensions: Extension = []) {
  const [anchor, head] = [source.indexOf("¦"), source.indexOf("¦", source.indexOf("¦") + 1)];
  const doc = source.replaceAll("¦", "");
  const selection = head < 0 ? EditorSelection.cursor(anchor) : EditorSelection.range(anchor, head - 1);
  return new EditorView({
    state: EditorState.create({ doc, selection, extensions: [markdown({ base: markdownLanguage }), autocompletion({ override: [() => null] }), extensions] }),
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

describe("wrapSelectionOnType", () => {
  /** Types `text` the way a DOM input reaches CodeMirror's input handlers. */
  function type(source: string, typed: string) {
    const view = editor(source, wrapSelectionOnType);
    const { from, to } = view.state.selection.main;
    const insert = () => view.state.update({ changes: { from, to, insert: typed }, selection: { anchor: from + typed.length } });
    if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, typed, insert))) view.dispatch(insert());
    const { from: start, to: end } = view.state.selection.main;
    return { doc: text(view), selected: view.state.sliceDoc(start, end) };
  }

  it("wraps selected text in marks, brackets and quotes and keeps it selected", () => {
    expect(type("a ¦word¦ b", "*")).toEqual({ doc: "a *word* b", selected: "word" });
    expect(type("a ¦word¦ b", "`")).toEqual({ doc: "a `word` b", selected: "word" });
    expect(type("a ¦word¦ b", "[")).toEqual({ doc: "a [word] b", selected: "word" });
    expect(type("a ¦word¦ b", "\"")).toEqual({ doc: "a \"word\" b", selected: "word" });
  });

  it("replaces the selection with other characters and types marks at a caret", () => {
    expect(type("a ¦word¦ b", "x")).toEqual({ doc: "a x b", selected: "" });
    expect(type("a ¦ b", "*")).toEqual({ doc: "a * b", selected: "" });
  });
});
