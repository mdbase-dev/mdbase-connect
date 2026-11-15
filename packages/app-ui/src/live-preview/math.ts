import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { t } from "@lingui/core/macro";
import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";
import "../i18n.js";
import { lazily } from "./lazy.js";
import { isRevealed, revealField } from "./reveal.js";

const DOLLAR = 36, BACKSLASH = 92, NEWLINE = 10;
const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === 13;
const isDigit = (ch: number) => ch >= 48 && ch <= 57;

/**
 * `$…$` and `$$…$$` math as Markdown syntax: `InlineMath` and `MathBlock`
 * nodes, each with two `MathMark` children around the TeX. Add it to the
 * `markdown()` language's `extensions` so the live preview renders formulas
 * and other syntax, such as emphasis, stays out of them.
 *
 * Inline math stays on one line. A single `$` opens only before a non-space
 * and closes only after a non-space and before a non-digit, so prices such as
 * "$5 and $10" stay text. A display block starts with a line that begins with
 * `$$` and ends at the next `$$`; an unclosed block runs to the end of its
 * container, like an unclosed code fence.
 */
export const markdownMath: MarkdownConfig = {
  defineNodes: [{ name: "MathBlock", block: true }, "InlineMath", "MathMark"],
  parseBlock: [{
    name: "MathBlock",
    before: "FencedCode",
    parse: parseBlock,
    endLeaf: (_cx, line) => blockOpening(line) !== null
  }],
  parseInline: [{ name: "InlineMath", after: "Escape", parse: parseInline }]
};

/** A line opening display math: `$$` followed by no other `$$` ("open"), or one whole-line `$$…$$` formula ("single"). */
function blockOpening(line: Line): "open" | "single" | null {
  if (line.next !== DOLLAR || line.text.charCodeAt(line.pos + 1) !== DOLLAR) return null;
  const rest = line.text.slice(line.pos + 2);
  const close = rest.indexOf("$$");
  if (close < 0) return "open";
  return rest.slice(0, close).trim() && !rest.slice(close + 2).trim() ? "single" : null;
}

function parseBlock(cx: BlockContext, line: Line): boolean {
  const opening = blockOpening(line);
  if (!opening) return false;
  const from = cx.lineStart + line.pos;
  const marks = [cx.elt("MathMark", from, from + 2)];
  if (opening === "single") {
    const close = cx.lineStart + line.text.indexOf("$$", line.pos + 2);
    marks.push(cx.elt("MathMark", close, close + 2));
    cx.nextLine();
  } else {
    // Lezer's own fenced code stops at the first line outside its container
    // the same way. `Line.depth` (the containers a line continues) is not in
    // the typings, but every 1.x release has it.
    while (cx.nextLine() && (line as Line & { depth: number }).depth >= cx.depth) {
      marks.push(...line.markers);
      const close = line.text.indexOf("$$", line.pos);
      if (close >= 0) {
        marks.push(cx.elt("MathMark", cx.lineStart + close, cx.lineStart + close + 2));
        cx.nextLine();
        break;
      }
    }
  }
  cx.addElement(cx.elt("MathBlock", from, cx.prevLineEnd(), marks));
  return true;
}

function parseInline(cx: InlineContext, next: number, start: number): number {
  if (next !== DOLLAR || (start > cx.offset && cx.char(start - 1) === DOLLAR)) return -1;
  const size = cx.char(start + 1) === DOLLAR ? 2 : 1;
  const first = cx.char(start + size);
  if (first === DOLLAR || first < 0 || (size === 1 && isSpace(first))) return -1;
  for (let pos = start + size; pos < cx.end; pos++) {
    const ch = cx.char(pos);
    if (ch === NEWLINE) return -1;
    if (ch === BACKSLASH) {
      pos++;
      if (cx.char(pos) === NEWLINE) return -1;
      continue;
    }
    if (ch !== DOLLAR) continue;
    if (size === 2) {
      if (cx.char(pos + 1) !== DOLLAR) continue;
      if (!cx.slice(start + 2, pos).trim()) return -1;
    } else if (isSpace(cx.char(pos - 1)) || isDigit(cx.char(pos + 1))) {
      continue;
    }
    const end = pos + size;
    return cx.addElement(cx.elt("InlineMath", start, end, [cx.elt("MathMark", start, start + size), cx.elt("MathMark", pos, end)]));
  }
  return -1;
}

const loadKatex = lazily(() => import("katex"));
let katex: typeof import("katex") | undefined;

/** Where a formula sits: in text, as a display formula in text, as its own block, or under its revealed source. */
type MathKind = "inline" | "display" | "block" | "preview";

/**
 * A formula rendered by KaTeX. Formula text is untrusted: `trust` stays off,
 * so commands such as `\href` and `\includegraphics` render as errors, and
 * sizes are capped. KaTeX loads with the first formula.
 */
export class MathWidget extends WidgetType {
  constructor(readonly source: string, readonly kind: MathKind) { super(); }

  eq(other: MathWidget) { return this.source === other.source && this.kind === other.kind; }

  toDOM(view: EditorView) {
    const element = document.createElement(this.kind === "block" || this.kind === "preview" ? "div" : "span");
    element.className = `cm-lp-math cm-lp-math-${this.kind}`;
    if (katex) {
      render(katex, element, this.source, this.kind !== "inline");
      return element;
    }
    element.classList.add("cm-lp-math-pending");
    element.textContent = this.source;
    loadKatex().then((loaded) => {
      katex = loaded;
      element.classList.remove("cm-lp-math-pending");
      render(loaded, element, this.source, this.kind !== "inline");
      view.requestMeasure();
    }).catch(() => {
      element.classList.replace("cm-lp-math-pending", "cm-lp-math-failed");
      element.title = t`Formulas could not be shown. Check your connection and reopen the note.`;
    });
    return element;
  }

  // A press on a formula places the caret beside it, which reveals its source.
  ignoreEvent() { return false; }
}

function render(module: typeof import("katex"), element: HTMLElement, source: string, display: boolean) {
  // Invalid TeX renders as its source, coloured, with KaTeX's message as the title.
  module.render(source, element, {
    displayMode: display,
    throwOnError: false,
    errorColor: "var(--color-danger)",
    strict: "ignore",
    trust: false,
    maxSize: 20,
    maxExpand: 500
  });
}

const sourceMark = Decoration.mark({ class: "cm-lp-math-source" });

/** Renders `markdownMath` formulas where the selection is not, and shows a rendered preview under a revealed display block. */
export function mathPreview() {
  return EditorView.decorations.compute(["doc", revealField], build);
}

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({ enter(node) {
    if (node.name !== "InlineMath" && node.name !== "MathBlock") return;
    const marks = node.node.getChildren("MathMark");
    const source = marks.length === 2 ? state.sliceDoc(marks[0].to, marks[1].from).trim() : "";
    const revealed = isRevealed(state, node.from, node.to);
    const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
    const topLevel = node.name === "MathBlock" && node.node.parent?.name === "Document";
    // Quote and list markers would be part of a nested multi-line formula, so it stays source.
    if (!source || revealed || (!topLevel && first.number !== last.number)) {
      ranges.push(sourceMark.range(node.from, node.to));
      if (source && revealed && topLevel) ranges.push(Decoration.widget({ widget: new MathWidget(source, "preview"), block: true, side: 1 }).range(last.to));
    } else if (topLevel) {
      ranges.push(Decoration.replace({ widget: new MathWidget(source, "block"), block: true }).range(first.from, last.to));
    } else {
      const display = node.name === "MathBlock" || marks[0].to - marks[0].from === 2;
      ranges.push(Decoration.replace({ widget: new MathWidget(source, display ? "display" : "inline") }).range(node.from, node.to));
    }
    return false;
  }});
  return Decoration.set(ranges, true);
}
