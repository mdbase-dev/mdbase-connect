// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import { inlinePreview } from "./inline.js";
import { revealTracking } from "./reveal.js";

let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; });

/** The text of each revealed mark that hangs in the margin, with the caret at `caret`. */
function hanging(doc: string, caret: number) {
  view = new EditorView({ doc, selection: { anchor: caret }, extensions: [markdown({ base: markdownLanguage }), revealTracking(), inlinePreview({})], parent: document.body });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  const focus = view.state.facet(EditorView.focusChangeEffect).map((effect) => effect(view!.state, true)).filter((effect) => effect !== null);
  view.dispatch({ effects: focus });
  return [...view.contentDOM.querySelectorAll(".cm-lp-outdent")].map((mark) => mark.textContent);
}

it.each([
  ["# Title", 3, ["# "]],
  ["##   Spaced", 6, ["##   "]],
  ["# Closed #", 3, ["# "]],
  ["> Quoted", 3, ["> "]],
  [">  Two spaces", 3, ["> "]],
  ["> > Nested", 6, ["> ", "> "]],
  ["# Title", 7, ["# "]]
])("a revealed mark in %j hangs with the space after it, so the text does not move", (doc, caret, marks) => {
  expect(hanging(doc, caret)).toEqual(marks);
});

it("hides the marks while the caret is elsewhere", () => {
  expect(hanging("# Title\n\nAfter", 14)).toEqual([]);
});
