// @vitest-environment jsdom
import { indentMore } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { expect, it } from "vitest";
import { blockPreview } from "./blocks.js";
import { revealTracking } from "./reveal.js";

function stateFor(doc: string, caret = doc.length) {
  let state = EditorState.create({ doc, selection: { anchor: caret }, extensions: [markdown({ base: markdownLanguage }), revealTracking(), blockPreview()] });
  const effects = state.facet(EditorView.focusChangeEffect).map((effect) => effect(state, true)).filter((effect) => effect !== null);
  state = state.update({ effects }).state;
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({}).state;
}

/** Each decoration as text: line classes, hidden or replaced source, widgets and marks. */
function decorations(state: EditorState) {
  const found: string[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === "function") continue;
    (set as DecorationSet).between(0, state.doc.length, (from, to, value) => {
      const spec = value.spec;
      const text = JSON.stringify(state.sliceDoc(from, to));
      if (spec.class && from === to) found.push(`line ${state.doc.lineAt(from).number}: ${spec.class.replace(/\s+/g, " ").trim()}`);
      else if (spec.widget) found.push(`${spec.widget.constructor.name} ${text}`);
      else if (spec.class) found.push(`mark ${text}${spec.attributes?.title ? ` title ${spec.attributes.title}` : ""}`);
      else found.push(`${spec.block ? "fold" : "hide"} ${text}`);
    });
  }
  return found;
}

it("renders a fenced code block with a header and hides its fences until the caret reaches them", () => {
  const doc = "```js\nconst a = 1;\n```\n\nAfter";
  expect(decorations(stateFor(doc))).toEqual([
    "line 1: cm-lp-code-block cm-lp-code-first", "CodeHeader \"```js\"",
    "line 2: cm-lp-code-block", "line 3: cm-lp-code-block cm-lp-code-last", "line 3: cm-lp-code-fence-end", "hide \"```\""
  ]);
  expect(decorations(stateFor(doc, 2))).not.toContain("CodeHeader \"```js\"");
  expect(decorations(stateFor(doc, 20))).not.toContain("hide \"```\"");
});

it("renders callouts with their titles and keeps a folded callout's body hidden", () => {
  const found = decorations(stateFor("> [!tip]- Folded\n> hidden\n> lines\n\n> [!warning]\n> careful\n\nAfter"));
  expect(found).toContain("CalloutHeader \"> [!tip]- Folded\"");
  expect(found).toContain("line 1: cm-lp-callout cm-lp-callout-tip cm-lp-callout-first cm-lp-callout-last");
  expect(found).toContain("fold \"> hidden\\n> lines\"");
  expect(found).toContain("line 6: cm-lp-callout cm-lp-callout-warning cm-lp-callout-last");
});

it("shows footnote references with their definitions, outside code, and reveals one under the caret", () => {
  const doc = "A note[^1] and `code [^1]` and [^missing].\n\n```\n[^1]\n```\n\n[^1]: First note";
  const found = decorations(stateFor(doc));
  expect(found.filter((entry) => entry.startsWith("mark"))).toEqual(["mark \"1\" title First note", "mark \"missing\""]);
  expect(found).toContain("line 7: cm-lp-footnote-definition");

  // A caret move changes only what is revealed.
  const moved = stateFor(doc).update({ selection: EditorSelection.cursor(8) }).state;
  expect(decorations(moved).filter((entry) => entry.startsWith("mark"))).toEqual(["mark \"missing\""]);
});

it("indents with Tab only inside code", () => {
  const press = (caret: number) => {
    const view = new EditorView({ state: stateFor("```\ncode\n```\ntext", caret) });
    const handled = view.state.facet(keymap).flat().find((binding) => binding.key === "Tab")!.run!(view);
    const text = view.state.doc.toString();
    view.destroy();
    return { handled, text };
  };
  expect(press(5)).toEqual({ handled: true, text: "```\n" + indentUnit() + "code\n```\ntext" });
  expect(press(15).handled).toBe(false);
});

function indentUnit() {
  const view = new EditorView({ state: EditorState.create({ doc: "x" }) });
  indentMore(view);
  const unit = view.state.doc.toString().slice(0, -1);
  view.destroy();
  return unit;
}
