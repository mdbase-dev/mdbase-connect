import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { t } from "@lingui/core/macro";
import { DiagramWidget, isDiagramLanguage } from "./diagram.js";
import { proseEdit } from "./prose-edit.js";
import { drawnBlocks, isDrawn, renderedBlockLayer, renderedBlocks, type RenderedBlock } from "./rendered-blocks.js";
import { isRevealed, revealField } from "./reveal.js";

const toggleFold = StateEffect.define<{ from: number; folded: boolean }>({ map: (value, changes) => ({ ...value, from: changes.mapPos(value.from) }) });
const folds = StateField.define<ReadonlyMap<number, boolean>>({
  create: () => new Map(),
  update(value, tr) {
    if (!tr.docChanged && !tr.effects.some((effect) => effect.is(toggleFold))) return value;
    const next = new Map<number, boolean>();
    for (const [pos, folded] of value) next.set(tr.changes.mapPos(pos), folded);
    for (const effect of tr.effects) if (effect.is(toggleFold)) next.set(effect.value.from, effect.value.folded);
    return next;
  }
});

const hide = Decoration.replace({});
const codeLine = (edge: string) => Decoration.line({ class: `cm-lp-code-block ${edge}` });
const footnote = Decoration.mark({ class: "cm-lp-footnote-ref" });
const types: Record<string, string> = {
  note: "✎", info: "ⓘ", tip: "✦", success: "✓", warning: "!", danger: "!",
  question: "?", quote: "❞", example: "☷", todo: "✓"
};

function typeTitle(type: string): string {
  switch (type) {
    case "info": return t({ message: "Info", context: "callout type" });
    case "tip": return t({ message: "Tip", context: "callout type" });
    case "success": return t({ message: "Success", context: "callout type" });
    case "warning": return t({ message: "Warning", context: "callout type" });
    case "danger": return t({ message: "Danger", context: "callout type" });
    case "question": return t({ message: "Question", context: "callout type" });
    case "quote": return t({ message: "Quote", context: "callout type" });
    case "example": return t({ message: "Example", context: "callout type" });
    case "todo": return t({ message: "Todo", context: "callout type" });
    default: return t({ message: "Note", context: "callout type" });
  }
}

export function calloutHeader(text: string) {
  return /^\s*>\s*\[!([\w-]+)\]([+-])?(?:[ \t]+(.*?))?[ \t]*$/i.exec(text);
}

class CodeHeader extends WidgetType {
  constructor(readonly language: string, readonly code: string) { super(); }
  eq(other: CodeHeader) { return this.language === other.language && this.code === other.code; }
  toDOM() {
    const row = document.createElement("span");
    row.className = "cm-lp-code-header";
    const label = document.createElement("span");
    label.textContent = this.language;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t`Copy`;
    button.setAttribute("aria-label", t`Copy code`);
    button.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.code).then(() => {
        button.textContent = t`Copied`;
        window.setTimeout(() => { button.textContent = t`Copy`; }, 1500);
      }).catch(() => { button.textContent = t`Copy failed`; });
    });
    row.append(label, button);
    return row;
  }
  ignoreEvent() { return true; }
}

class CalloutHeader extends WidgetType {
  constructor(readonly type: string, readonly title: string, readonly from: number, readonly foldable: boolean, readonly folded: boolean) { super(); }
  eq(other: CalloutHeader) { return this.type === other.type && this.title === other.title && this.from === other.from && this.foldable === other.foldable && this.folded === other.folded; }
  toDOM(view: EditorView) {
    const row = document.createElement("span");
    row.className = "cm-lp-callout-header";
    const icon = document.createElement("span");
    icon.className = "cm-lp-callout-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = types[this.type];
    const title = document.createElement("span");
    title.textContent = this.title;
    row.append(icon, title);
    if (this.foldable) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = this.folded ? "▸" : "▾";
      button.setAttribute("aria-expanded", String(!this.folded));
      button.setAttribute("aria-label", this.folded ? t`Expand callout` : t`Collapse callout`);
      button.addEventListener("click", () => view.dispatch({ effects: toggleFold.of({ from: this.from, folded: !this.folded }) }));
      row.append(button);
    }
    return row;
  }
  ignoreEvent() { return true; }
}

/** Code blocks, callouts and footnotes found in a note, kept until its text or parse changes. */
interface CodeBlock {
  from: number; to: number; fenced: boolean; language: string | undefined; closed: boolean; code: string; diagram: boolean;
  /** Start, end and indentation of each line, first to last. */
  lines: Array<{ from: number; to: number; indent: number }>;
}
interface Callout { from: number; to: number; type: string; title: string | undefined; fold: string | undefined; lines: number[]; lastTo: number }
interface Structure {
  codes: CodeBlock[];
  callouts: Callout[];
  definitions: Map<string, string>;
  definitionLines: number[];
  references: Array<{ from: number; to: number; key: string }>;
}

/** Blocks that hold only inline content, so they cannot contain code, quotes or callouts. */
const inlineBlocks = new Set([
  "Paragraph", "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2", "Table", "HTMLBlock", "LinkReference", "CommentBlock",
  "ProcessingInstructionBlock", "HorizontalRule", "Task"
]);
const unreferenced = ["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "InlineMath", "MathBlock"];

function analyze(state: EditorState): Structure {
  const codes: CodeBlock[] = [], callouts: Callout[] = [];
  const tree = syntaxTree(state);
  tree.iterate({ enter(node) {
    if (inlineBlocks.has(node.name)) return false;
    if (node.name === "FencedCode" || node.name === "CodeBlock") {
      const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
      const fenced = node.name === "FencedCode";
      const opening = fenced ? /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(first.text) : null;
      const closed = !!opening && last.number > first.number && new RegExp(`^\\s*${opening[1][0]}{${opening[1].length},}\\s*$`).test(last.text);
      const codeFrom = fenced ? Math.min(first.to + 1, state.doc.length) : first.from;
      const codeTo = closed ? Math.max(codeFrom, last.from - 1) : last.to;
      const code = state.sliceDoc(codeFrom, codeTo);
      // Quote and list markers would be part of a nested diagram's source, so only top-level fences render.
      const diagram = closed && isDiagramLanguage(opening![2]) && !!code.trim() && node.node.parent?.name === "Document";
      const lines: CodeBlock["lines"] = [];
      for (let n = first.number; n <= last.number; n++) {
        const line = state.doc.line(n);
        lines.push({ from: line.from, to: line.to, indent: fenced ? 0 : /^(?: {4}|\t)/.exec(line.text)?.[0].length ?? 0 });
      }
      codes.push({ from: node.from, to: node.to, fenced, language: opening?.[2], closed, code, diagram, lines });
      return false;
    }
    if (node.name === "Blockquote" && node.node.parent?.name !== "Blockquote") {
      const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
      const match = calloutHeader(first.text);
      if (!match) return;
      const lines: number[] = [];
      for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n).from);
      const type = match[1].toLowerCase() in types ? match[1].toLowerCase() : "note";
      callouts.push({ from: first.from, to: first.to, type, title: match[3] || undefined, fold: match[2], lines, lastTo: last.to });
    }
  }});

  // Footnotes are found line by line outside code; only lines with "[^" can hold one.
  const definitions = new Map<string, string>(), definitionLines: number[] = [];
  const references: Structure["references"] = [];
  let from = 0, code = 0;
  for (const iterator = state.doc.iterLines(); !iterator.next().done; from += iterator.value.length + 1) {
    const text = iterator.value;
    if (!text.includes("[^")) continue;
    while (code < codes.length && codes[code]!.to < from) code++;
    if (code < codes.length && from >= codes[code]!.from) continue;
    const definition = /^ {0,3}\[\^([^\]\s]+)\]:\s*(.*)$/.exec(text);
    if (definition) {
      definitions.set(definition[1]!.toLowerCase(), definition[2]!);
      definitionLines.push(from);
      continue;
    }
    if (/^ {0,3}\[\^[^\]]+\]:/.test(text)) continue;
    for (const match of text.matchAll(/(?<![\\!])\[\^([^\]\s]+)\]/g)) {
      const start = from + match.index!;
      const node = tree.resolveInner(start, 1);
      if (unreferenced.some((name) => { for (let p: typeof node | null = node; p; p = p.parent) if (p.name === name) return true; return false; })) continue;
      references.push({ from: start, to: start + match[0].length, key: match[1]!.toLowerCase() });
    }
  }
  return { codes, callouts, definitions, definitionLines, references };
}

const structure = StateField.define<Structure>({
  create: analyze,
  update(value, transaction) {
    // Typing in prose only moves the blocks and footnotes on other lines.
    if (proseEdit(transaction)) {
      const map = (pos: number) => transaction.changes.mapPos(pos);
      return {
        codes: value.codes.map((block) => ({
          ...block, from: map(block.from), to: map(block.to),
          lines: block.lines.map((line) => ({ ...line, from: map(line.from), to: map(line.to) }))
        })),
        callouts: value.callouts.map((callout) => ({
          ...callout, from: map(callout.from), to: map(callout.to), lines: callout.lines.map(map), lastTo: map(callout.lastTo)
        })),
        definitions: value.definitions,
        definitionLines: value.definitionLines.map(map),
        references: value.references.map((reference) => ({ ...reference, from: map(reference.from), to: map(reference.to) }))
      };
    }
    return transaction.docChanged || syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
      ? analyze(transaction.state)
      : value;
  }
});

export function blockPreview() {
  return [folds, structure, renderedBlocks.compute([structure, folds], rendered), renderedBlockLayer, EditorView.decorations.compute([structure, revealField, folds, drawnBlocks], build), keymap.of([
    { key: "Tab", run: (view) => inCode(view.state) && indentMore(view) },
    { key: "Shift-Tab", run: (view) => inCode(view.state) && indentLess(view) }
  ])];
}

function inCode(state: EditorState): boolean {
  const { codes } = state.field(structure);
  return state.selection.ranges.every(({ head }) => codes.some((block) => head > block.from && head < block.to));
}

function isFolded(callout: Callout, foldState: ReadonlyMap<number, boolean>): boolean {
  return callout.fold ? (foldState.get(callout.from) ?? callout.fold === "-") : false;
}

/** Diagrams, and the bodies of folded callouts. */
function rendered(state: EditorState): RenderedBlock[] {
  const { codes, callouts } = state.field(structure);
  const foldState = state.field(folds);
  const blocks: RenderedBlock[] = [];
  for (const block of codes) if (block.diagram) blocks.push({ from: block.from, to: block.to, widget: new DiagramWidget(block.code) });
  for (const callout of callouts) {
    if (callout.lines.length > 1 && isFolded(callout, foldState)) blocks.push({ from: callout.to + 1, to: callout.lastTo });
  }
  return blocks;
}

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const { codes, callouts, definitions, definitionLines, references } = state.field(structure);
  const foldState = state.field(folds);
  for (const block of codes) {
    const first = block.lines[0]!, last = block.lines[block.lines.length - 1]!;
    // A drawn diagram stands for these lines; see `rendered`.
    if (block.diagram && isDrawn(state, first.from)) continue;
    block.lines.forEach((line, index) => {
      const edge = `${index === 0 ? "cm-lp-code-first" : ""} ${index === block.lines.length - 1 ? "cm-lp-code-last" : ""}`;
      ranges.push(codeLine(edge).range(line.from));
      if (!block.fenced && line.indent && !isRevealed(state, line.from, line.to)) ranges.push(hide.range(line.from, line.from + line.indent));
    });
    if (block.fenced && !isRevealed(state, first.from, first.to)) {
      ranges.push(Decoration.replace({ widget: new CodeHeader(block.language ?? "", block.code) }).range(first.from, first.to));
    } else if (!block.fenced) {
      ranges.push(Decoration.widget({ widget: new CodeHeader("", block.code.replace(/^(?: {4}|\t)/gm, "")), side: -1 }).range(first.from));
    }
    // The hidden closing fence keeps its line, so showing it moves nothing below.
    if (block.closed && !isRevealed(state, last.from, last.to)) ranges.push(hide.range(last.from, last.to));
  }
  for (const callout of callouts) {
    const folded = isFolded(callout, foldState);
    callout.lines.forEach((from, index) => {
      const last = index === callout.lines.length - 1;
      ranges.push(Decoration.line({ class: `cm-lp-callout cm-lp-callout-${callout.type}${index === 0 ? " cm-lp-callout-first" : ""}${last || folded && index === 0 ? " cm-lp-callout-last" : ""}` }).range(from));
    });
    if (!isRevealed(state, callout.from, callout.to)) {
      ranges.push(Decoration.replace({ widget: new CalloutHeader(callout.type, callout.title ?? typeTitle(callout.type), callout.from, !!callout.fold, folded) }).range(callout.from, callout.to));
    }
  }
  for (const from of definitionLines) ranges.push(Decoration.line({ class: "cm-lp-footnote-definition" }).range(from));
  for (const { from, to, key } of references) {
    if (isRevealed(state, from, to)) continue;
    const text = definitions.get(key);
    ranges.push((text ? Decoration.mark({ class: "cm-lp-footnote-ref", attributes: { title: text } }) : footnote).range(from + 2, to - 1));
    ranges.push(hide.range(from, from + 2), hide.range(to - 1, to));
  }
  return Decoration.set(ranges, true);
}
