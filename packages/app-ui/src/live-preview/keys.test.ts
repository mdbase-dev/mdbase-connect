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

/**
 * A table whose header cell "Column one" wraps after "Column" while the row's last cell does not.
 * The editor here has no layout, so the row's geometry is given: the cell's lines are 20 px tall,
 * at 0–20 and 20–40, and the hidden delimiter row has no height.
 */
function wrappedHeader(caret: number, movedTo: number) {
  const view = viewWith("Intro\n\n| Column one | Two |\n| --- | --- |\n| a | b |", 1);
  const { doc } = view.state;
  const row = doc.line(3), delimiter = doc.line(4);
  const realBlock = view.lineBlockAt.bind(view);
  const second = row.from + "| Column ".length;
  Object.defineProperty(view, "documentTop", { value: 0 });
  Object.defineProperty(view, "defaultLineHeight", { value: 20 });
  view.lineBlockAt = (pos) => {
    const block = realBlock(pos);
    if (pos >= row.from && pos <= row.to) return Object.assign(Object.create(Object.getPrototypeOf(block)), block, { top: 0, height: 40 });
    if (pos >= delimiter.from && pos <= delimiter.to) return Object.assign(Object.create(Object.getPrototypeOf(block)), block, { height: 0 });
    return block;
  };
  view.coordsAtPos = (pos) => {
    const top = pos < row.from ? -40 : pos < second ? 0 : pos <= row.to ? 20 : 60;
    return { top, bottom: top + 20, left: 9, right: 9 };
  };
  view.posAtCoords = (({ y }: { y: number }) => (y < 0 ? 0 : y < 20 ? row.from + 2 : y < 40 ? second : doc.line(5).from + 2)) as EditorView["posAtCoords"];
  view.moveVertically = () => EditorSelection.cursor(movedTo, 0, undefined, 9);
  view.dispatch({ selection: { anchor: caret } });
  return { view, first: row.from + 2, second, below: doc.line(5).from + 2 };
}

it("visits each line of a wrapped table cell going down, as going up", () => {
  // CodeMirror judges the row's end by its last cell, which ends on the first line: from
  // "Column" it reaches the next row.
  const header = wrappedHeader(9, 44);
  expect(header.first).toBe(9);
  expect(press(header.view, "ArrowDown")).toBe(true);
  expect(header.view.state.selection.main.head).toBe(header.second);

  const up = wrappedHeader(16, 0);
  expect(press(up.view, "ArrowUp")).toBe(true);
  expect(up.view.state.selection.main.head).toBe(up.first);
});

it("leaves the row for CodeMirror once the cell's lines run out", () => {
  const { view, second } = wrappedHeader(16, 44);
  expect(second).toBe(16);
  expect(press(view, "ArrowDown")).toBe(false);
  expect(view.state.selection.main.head).toBe(16);
});
