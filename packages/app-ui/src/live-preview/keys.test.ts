// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { livePreviewKeys } from "./keys.js";
import { markdownMath, mathPreview } from "./math.js";
import { revealTracking } from "./reveal.js";

vi.mock("katex", () => ({ render: vi.fn() }));

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

/** A note with a display formula, which renders as a block over its three lines. */
function viewWith(doc: string, caretLine: number) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage, extensions: [markdownMath] }), revealTracking(), mathPreview(), livePreviewKeys] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state: state.update({}).state, parent: document.body });
  views.push(view);
  view.dispatch({ selection: { anchor: view.state.doc.line(caretLine).from } });
  return view;
}

function press(view: EditorView, key: string) {
  return view.state.facet(keymap).flat().find((binding) => binding.key === key)!.run!(view);
}

const lineOf = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number;
const note = "Before\n\n$$\nx^2\n$$\n\nAfter";

it("stops at a rendered block that vertical motion would step over", () => {
  // CodeMirror's vertical motion passes block widgets by: from line 2 it reaches line 6.
  const down = viewWith(note, 2);
  down.moveVertically = () => EditorSelection.cursor(down.state.doc.line(6).from);
  expect(press(down, "ArrowDown")).toBe(true);
  expect(lineOf(down)).toBe(3);

  const up = viewWith(note, 6);
  up.moveVertically = () => EditorSelection.cursor(up.state.doc.line(2).from);
  expect(press(up, "ArrowUp")).toBe(true);
  expect(lineOf(up)).toBe(5);
});

it("leaves motion that skips no shown line to CodeMirror", () => {
  const view = viewWith(note, 1);
  view.moveVertically = () => EditorSelection.cursor(view.state.doc.line(2).from);
  expect(press(view, "ArrowDown")).toBe(false);
  expect(lineOf(view)).toBe(1);
});
