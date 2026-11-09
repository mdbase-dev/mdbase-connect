import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { t } from "@lingui/core/macro";
import { isRevealed, revealField } from "./reveal.js";

const toggleFold = StateEffect.define<{ from: number; folded: boolean }>({ map: (value, changes) => ({ ...value, from: changes.mapPos(value.from) }) });
const folds = StateField.define<ReadonlyMap<number, boolean>>({
  create: () => new Map(),
  update(value, tr) {
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

export function blockPreview() {
  return [folds, EditorView.decorations.compute(["doc", revealField, folds], build), keymap.of([
    { key: "Tab", run: (view) => inCode(view.state) && indentMore(view) },
    { key: "Shift-Tab", run: (view) => inCode(view.state) && indentLess(view) }
  ])];
}

function inCode(state: EditorState): boolean {
  const positions = state.selection.ranges.map(({ head }) => head);
  const matched = positions.map(() => false);
  syntaxTree(state).iterate({ enter(node) {
    if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
    positions.forEach((pos, index) => { if (pos > node.from && pos < node.to) matched[index] = true; });
    return false;
  }});
  return matched.every(Boolean);
}

function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const skip: Array<{from: number; to: number}> = [];
  const foldState = state.field(folds);
  syntaxTree(state).iterate({ enter(node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") {
      const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
      skip.push({ from: node.from, to: node.to });
      const fenced = node.name === "FencedCode";
      const opening = fenced ? /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(first.text) : null;
      const closed = opening && last.number > first.number && new RegExp(`^\\s*${opening[1][0]}{${opening[1].length},}\\s*$`).test(last.text);
      const codeFrom = fenced ? Math.min(first.to + 1, state.doc.length) : first.from;
      const codeTo = closed ? Math.max(codeFrom, last.from - 1) : last.to;
      const code = state.sliceDoc(codeFrom, codeTo);
      for (let n = first.number; n <= last.number; n++) {
        const line = state.doc.line(n);
        const edge = `${n === first.number ? "cm-lp-code-first" : ""} ${n === last.number ? "cm-lp-code-last" : ""}`;
        ranges.push(codeLine(edge).range(line.from));
        if (!fenced && !isRevealed(state, line.from, line.to)) {
          const indent = /^(?: {4}|\t)/.exec(line.text);
          if (indent) ranges.push(hide.range(line.from, line.from + indent[0].length));
        }
      }
      if (fenced && !isRevealed(state, first.from, first.to)) {
        ranges.push(Decoration.replace({ widget: new CodeHeader(opening?.[2] ?? "", code) }).range(first.from, first.to));
      } else if (!fenced) {
        ranges.push(Decoration.widget({ widget: new CodeHeader("", code.replace(/^(?: {4}|\t)/gm, "")), side: -1 }).range(first.from));
      }
      if (closed && !isRevealed(state, last.from, last.to)) {
        ranges.push(Decoration.line({ class: "cm-lp-code-fence-end" }).range(last.from));
        ranges.push(hide.range(last.from, last.to));
      }
      return false;
    }
    if (node.name === "Blockquote") {
      if (node.node.parent?.name === "Blockquote") return;
      const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
      const match = calloutHeader(first.text);
      if (!match) return;
      const type = match[1].toLowerCase() in types ? match[1].toLowerCase() : "note";
      const title = match[3] || typeTitle(type);
      const folded = match[2] ? (foldState.get(first.from) ?? match[2] === "-") : false;
      for (let n = first.number; n <= last.number; n++) {
        const line = state.doc.line(n);
        ranges.push(Decoration.line({ class: `cm-lp-callout cm-lp-callout-${type}${n === first.number ? " cm-lp-callout-first" : ""}${n === last.number || folded && n === first.number ? " cm-lp-callout-last" : ""}` }).range(line.from));
      }
      if (!isRevealed(state, first.from, first.to)) ranges.push(Decoration.replace({ widget: new CalloutHeader(type, title, first.from, !!match[2], folded) }).range(first.from, first.to));
      if (folded && first.number < last.number && !isRevealed(state, first.to + 1, last.to)) {
        ranges.push(Decoration.replace({ block: true }).range(first.to + 1, last.to));
      }
    }
  }});
  const definitions = new Map<string, string>();
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (skip.some((part) => line.from >= part.from && line.from <= part.to)) continue;
    const def = /^ {0,3}\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line.text);
    if (def) {
      definitions.set(def[1].toLowerCase(), def[2]);
      ranges.push(Decoration.line({ class: "cm-lp-footnote-definition" }).range(line.from));
      continue;
    }
  }
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (skip.some((part) => line.from >= part.from && line.from <= part.to) || /^ {0,3}\[\^[^\]]+\]:/.test(line.text)) continue;
    for (const match of line.text.matchAll(/(?<![\\!])\[\^([^\]\s]+)\]/g)) {
      const from = line.from + match.index!, to = from + match[0].length;
      const node = syntaxTree(state).resolveInner(from, 1);
      if (["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock"].some((name) => { for (let p: typeof node | null = node; p; p = p.parent) if (p.name === name) return true; return false; })) continue;
      if (!isRevealed(state, from, to)) {
        const text = definitions.get(match[1].toLowerCase());
        ranges.push((text ? Decoration.mark({ class: "cm-lp-footnote-ref", attributes: { title: text } }) : footnote).range(from + 2, to - 1));
        ranges.push(hide.range(from, from + 2), hide.range(to - 1, to));
      }
    }
  }
  return Decoration.set(ranges, true);
}
