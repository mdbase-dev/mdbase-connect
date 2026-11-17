// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { blockPreview } from "./blocks.js";
import { markdownMath, mathPreview } from "./math.js";
import { proseEdit } from "./prose-edit.js";
import { revealTracking } from "./reveal.js";

vi.mock("katex", () => ({ render: vi.fn() }));

const extensions = [markdown({ base: markdownLanguage, extensions: [markdownMath] }), revealTracking(), blockPreview(), mathPreview()];

function parsed(doc: string) {
  const state = EditorState.create({ doc, extensions });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({}).state;
}

function decorations(state: EditorState) {
  const found: string[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    (set as DecorationSet).between(0, state.doc.length, (from, to, value) => {
      found.push(`${from}-${to} ${JSON.stringify(value.spec)}`);
    });
  }
  return found;
}

const note = [
  "# Title with words",
  "",
  "A paragraph of prose with a footnote[^a] and $x^2$ inline.",
  "Second line of the same paragraph, plain words here.",
  "",
  "- a list item with text",
  "- another item",
  "",
  "```js",
  "const code = 1;",
  "```",
  "",
  "    indented code",
  "",
  "> [!tip] Callout title",
  "> callout body text",
  "lazy continuation words",
  "",
  "$$",
  "\\int x",
  "$$",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "Closing paragraph with plain words.",
  "",
  "[^a]: The footnote text."
].join("\n");

it("treats typing inside a line of prose as prose, and line starts and syntax as structure", () => {
  const state = parsed(note);
  const at = (text: string, offset = 0) => note.indexOf(text) + offset;
  const typed = (pos: number, insert: string, to = pos) => proseEdit(state.update({ changes: { from: pos, to, insert } }));
  expect(typed(at("Second line", 6), "x")).toBe(true);
  expect(typed(at("Title with", 3), "x")).toBe(true);
  expect(typed(at("a list item", 4), "x")).toBe(true);
  expect(typed(at("lazy continuation", 4), "x")).toBe(true);
  // A line that holds syntax the structure records.
  expect(typed(at("A paragraph", 4), "x")).toBe(false);
  expect(typed(at("Second line", 6), "$")).toBe(false);
  expect(typed(at("Second line", 6), "`")).toBe(false);
  expect(typed(at("Callout title", 3), "x")).toBe(false);
  // The start of a line decides its block.
  expect(typed(at("Second line"), "    ")).toBe(false);
  expect(typed(at("another item", 0), "x")).toBe(false);
  // Line breaks, code and tables.
  expect(typed(at("Second line", 6), "\n")).toBe(false);
  expect(typed(at("Second line", 6), "", at("Second line", 6) + 60)).toBe(false);
  expect(typed(at("const code", 3), "x")).toBe(false);
  expect(typed(at("| 1 |", 2), "x")).toBe(false);
});

it("keeps block and math structure equal to a fresh analysis through random edits", () => {
  let state = parsed(note);
  let seed = 11;
  const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
  const inserts = ["x", "x", "x", "x", "x", "x", "word ", "word ", " ", "", "`", "$", "$y$", "-", "\n", "[^a]", "> ", "```\n", "    "];
  let prose = 0;
  for (let step = 0; step < 400; step++) {
    // Start over now and then, before random syntax leaves no prose to type in.
    if (step % 25 === 0) state = parsed(note);
    const from = random(state.doc.length + 1);
    const transaction = state.update({ changes: { from, to: Math.min(state.doc.length, from + random(3)), insert: inserts[random(inserts.length)]! } });
    // The parse may finish after the transaction, as it does in the editor; the
    // fields then analyze again. Count only prose edits whose tree was complete.
    ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5000);
    state = transaction.state.update({}).state;
    if (proseEdit(transaction) && syntaxTree(state) === syntaxTree(transaction.state)) prose++;
    const fresh = parsed(state.doc.toString());
    // Lezer's incremental parse can disagree with a fresh one (removing the
    // indentation of an indented code block keeps the code block); the fields
    // can only follow the tree they are given.
    if (syntaxTree(state).toString() !== syntaxTree(fresh).toString()) { state = fresh; continue; }
    expect(decorations(state)).toEqual(decorations(fresh));
  }
  expect(prose).toBeGreaterThan(50);
});
