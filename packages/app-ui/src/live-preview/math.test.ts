// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { beforeEach, expect, it, vi } from "vitest";
import { markdownMath, mathPreview, MathBlockWidget, MathWidget } from "./math.js";
import { revealTracking } from "./reveal.js";

const katex = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("katex", () => ({ render: katex.render }));

beforeEach(() => {
  katex.render.mockReset();
  katex.render.mockImplementation((source: string, element: HTMLElement) => { element.textContent = `rendered:${source}`; });
});

function stateFor(doc: string, caret?: number, focused = false) {
  let state = EditorState.create({
    doc,
    selection: { anchor: caret ?? doc.length },
    extensions: [markdown({ base: markdownLanguage, extensions: [markdownMath] }), revealTracking(), mathPreview()]
  });
  if (focused) {
    const effects = state.facet(EditorView.focusChangeEffect).map((effect) => effect(state, true)).filter((effect) => effect !== null);
    state = state.update({ effects }).state;
  }
  // Finish the parse and hand it to the state, as the editor's background parse does.
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({}).state;
}

function nodes(doc: string, name: string) {
  const state = stateFor(doc);
  const found: string[] = [];
  syntaxTree(state).iterate({ enter(node) { if (node.name === name) found.push(state.sliceDoc(node.from, node.to)); } });
  return found;
}

function decorations(state: EditorState) {
  const found: Array<{ from: number; to: number; kind?: string; source?: string; block?: boolean; mark?: string }> = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    (set as DecorationSet).between(0, state.doc.length, (from, to, value) => {
      const widget = value.spec.widget;
      if (widget instanceof MathWidget || widget instanceof MathBlockWidget) found.push({ from, to, kind: widget.kind, source: widget.source, block: !!value.spec.block });
      else if (value.spec.class) found.push({ from, to, mark: value.spec.class });
    });
  }
  // Formulas drawn as blocks and formulas in text are separate sets.
  return found.sort((a, b) => a.from - b.from);
}

it("parses inline math on one line and leaves prices, escapes and spaced dollars as text", () => {
  expect(nodes("Euler: $e^{i\\pi} + 1 = 0$ and $$\\int x$$.", "InlineMath")).toEqual(["$e^{i\\pi} + 1 = 0$", "$$\\int x$$"]);
  expect(nodes("It costs $5 and $10 today.", "InlineMath")).toEqual([]);
  expect(nodes("Escaped \\$x$ and $ x$ and $x $ and $x$5", "InlineMath")).toEqual([]);
  expect(nodes("Starts $x\nand ends$ here", "InlineMath")).toEqual([]);
  expect(nodes("A $\\$5$ price", "InlineMath")).toEqual(["$\\$5$"]);
});

it("keeps emphasis, links and code out of formulas", () => {
  expect(nodes("$a_1 * b_2 * c_3$", "Emphasis")).toEqual([]);
  expect(nodes("$[x](y)$", "Link")).toEqual([]);
  expect(nodes("`$x$`", "InlineMath")).toEqual([]);
});

it("parses display blocks, one-line blocks and a block interrupting a paragraph", () => {
  expect(nodes("$$\na^2 + b^2\n$$\n\nAfter", "MathBlock")).toEqual(["$$\na^2 + b^2\n$$"]);
  expect(nodes("$$ x = 1 $$\nText", "MathBlock")).toEqual(["$$ x = 1 $$"]);
  expect(nodes("Text\n$$\nx\n$$", "MathBlock")).toEqual(["$$\nx\n$$"]);
  expect(nodes("$$x$$ is inline here", "MathBlock")).toEqual([]);
  expect(nodes("> $$\n> x\n> $$", "MathBlock")).toEqual(["$$\n> x\n> $$"]);
  // Unclosed, like a code fence: the rest of the container.
  expect(nodes("$$\nx\n\nmore", "MathBlock")).toEqual(["$$\nx\n\nmore"]);
  expect(nodes("> $$\n> x\n\nAfter $$", "MathBlock")).toEqual(["$$\n> x"]);
});

it("renders a formula past the first parse once the rest of a long note is parsed", () => {
  const filler = "Prose that the first parse of a note covers, line after line.\n\n".repeat(80);
  const block = "$$\nx^2\n$$";
  expect(decorations(stateFor(`${filler}${block}\n`, 0))).toEqual([{ from: filler.length, to: filler.length + block.length, kind: "block", source: "x^2", block: true }]);
});

it("renders formulas where the selection is not", () => {
  const doc = "Inline $x^2$ and $$y$$.\n\n$$\n\\sum_i i\n$$\n\nEnd";
  expect(decorations(stateFor(doc, 0))).toEqual([
    { from: 7, to: 12, kind: "inline", source: "x^2", block: false },
    { from: 17, to: 22, kind: "display", source: "y", block: false },
    { from: 25, to: 39, kind: "block", source: "\\sum_i i", block: true }
  ]);
});

it("shows the source, with a preview under a block, while a focused selection is in it", () => {
  const doc = "Inline $x^2$.\n\n$$\n\\sum_i i\n$$\n\nEnd";
  expect(decorations(stateFor(doc, 9, true))).toEqual(expect.arrayContaining([
    { from: 7, to: 12, mark: "cm-lp-math-source" }
  ]));
  expect(decorations(stateFor(doc, doc.indexOf("\\sum"), true))).toEqual([
    { from: 7, to: 12, kind: "inline", source: "x^2", block: false },
    { from: 15, to: 29, mark: "cm-lp-math-source" },
    { from: 29, to: 29, kind: "preview", source: "\\sum_i i", block: true }
  ]);
  // An unfocused editor keeps everything rendered.
  expect(decorations(stateFor(doc, 9)).every((decoration) => decoration.kind)).toBe(true);
});

it("renders a one-line formula in a quote but leaves nested multi-line and empty ones as source", () => {
  expect(decorations(stateFor("> $$ x $$\n\nEnd", 0))).toEqual([{ from: 2, to: 9, kind: "display", source: "x", block: false }]);
  expect(decorations(stateFor("> $$\n> x\n> $$\n\nEnd", 0))).toEqual([{ from: 2, to: 13, mark: "cm-lp-math-source" }]);
  expect(decorations(stateFor("$$\n\n$$x", 0)).filter((decoration) => decoration.kind)).toEqual([]);
});

function fakeView() {
  return { requestMeasure: vi.fn() } as unknown as EditorView & { requestMeasure: ReturnType<typeof vi.fn> };
}

it("renders with trust off and capped sizes, and draws later widgets at once", async () => {
  const view = fakeView();
  const element = new MathWidget("x^2", "inline").toDOM(view);
  expect(element.classList.contains("cm-lp-math-pending")).toBe(true);
  expect(element.textContent).toBe("x^2");
  await vi.waitFor(() => expect(element.textContent).toBe("rendered:x^2"));
  expect(element.classList.contains("cm-lp-math-pending")).toBe(false);
  expect(view.requestMeasure).toHaveBeenCalled();
  expect(katex.render.mock.calls[0][2]).toMatchObject({ displayMode: false, throwOnError: false, trust: false, maxSize: 20 });
  const block = new MathBlockWidget("y", "block").toDOM(view);
  expect(block.tagName).toBe("DIV");
  expect(block.textContent).toBe("rendered:y");
  expect(katex.render.mock.calls[1][2]).toMatchObject({ displayMode: true });
});

it("says so when KaTeX cannot load, and tries again for the next formula", async () => {
  vi.resetModules();
  vi.doMock("katex", () => { throw new Error("chunk failed"); });
  const { MathWidget: Fresh } = await import("./math.js");
  const failed = new Fresh("x", "inline").toDOM(fakeView());
  await vi.waitFor(() => expect(failed.classList.contains("cm-lp-math-failed")).toBe(true));
  expect(failed.textContent).toBe("x");
  expect(failed.title).toMatch(/could not be shown/);
  vi.doMock("katex", () => ({ render: katex.render }));
  const next = new Fresh("y", "inline").toDOM(fakeView());
  await vi.waitFor(() => expect(next.textContent).toBe("rendered:y"));
});
