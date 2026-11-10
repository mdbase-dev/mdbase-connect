import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { t } from "@lingui/core/macro";
import { calloutHeader } from "./blocks.js";
import { isRevealed, revealChanged } from "./reveal.js";

export interface LivePreviewLink {
  /** Start of the whole link source, including `[[` for a wikilink. */
  from: number;
  to: number;
  target: string;
  format: "markdown" | "wikilink";
}

export interface LivePreviewOptions {
  /** Whether a rendered link points nowhere. The app owns link resolution. */
  linkMissing?: (state: EditorState, link: LivePreviewLink) => boolean;
  /** Rebuild when a transaction carries app state that changes `linkMissing`. */
  refresh?: (update: ViewUpdate) => boolean;
}

const hide = Decoration.replace({});
const muted = Decoration.mark({ class: "cm-lp-mark" });
const styles: Record<string, Decoration> = {
  Emphasis: Decoration.mark({ class: "cm-lp-em" }),
  StrongEmphasis: Decoration.mark({ class: "cm-lp-strong" }),
  Strikethrough: Decoration.mark({ class: "cm-lp-strike" }),
  InlineCode: Decoration.mark({ class: "cm-lp-code" })
};
const inlineMarks: Record<string, string> = {
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark"
};
const headingLines = Array.from({ length: 6 }, (_, index) => Decoration.line({ class: `cm-lp-heading cm-lp-h${index + 1}` }));
const headingMark = Decoration.mark({ class: "cm-lp-mark cm-lp-outdent" });
const quoteMark = Decoration.mark({ class: "cm-lp-mark cm-lp-outdent" });
const escaped = Decoration.mark({ class: "cm-lp-escaped" });
const ruleLine = Decoration.line({ class: "cm-lp-rule" });

interface ListPrefix {
  /** Source columns before the marker, the marker itself, and the whole prefix. */
  leading: number;
  width: number;
  marker: string;
  /** Columns for the marker: an ordered list's numbers align on its widest. */
  markerWidth: number;
  depth: number;
  task?: { from: number; checked: boolean };
}

/** A list item's indent, bullet or number and task box as one box, as wide as its revealed source. */
class ListPrefixWidget extends WidgetType {
  constructor(readonly prefix: ListPrefix) { super(); }
  eq(other: ListPrefixWidget) {
    const a = this.prefix, b = other.prefix;
    return a.leading === b.leading && a.width === b.width && a.marker === b.marker && a.markerWidth === b.markerWidth && a.depth === b.depth
      && a.task?.from === b.task?.from && a.task?.checked === b.task?.checked;
  }
  toDOM() {
    const { leading, width, marker, markerWidth, depth, task } = this.prefix;
    const box = document.createElement("span");
    box.className = "cm-lp-list-prefix";
    box.style.paddingLeft = `${leading}ch`;
    const bullet = /^[-+*]$/.test(marker);
    // A task's checkbox takes its bullet's place.
    if (!(bullet && task)) {
      const mark = document.createElement("span");
      mark.className = bullet ? `cm-lp-bullet cm-lp-bullet-${depth % 3}` : "cm-lp-ordinal";
      if (bullet) mark.setAttribute("aria-hidden", "true");
      else mark.textContent = marker;
      mark.style.width = `${markerWidth + 1}ch`;
      box.append(mark);
    }
    if (task) box.append(taskBox(task.from, task.checked));
    box.style.width = `${width}ch`;
    return box;
  }
  ignoreEvent() { return false; }
}

function taskBox(from: number, checked: boolean) {
  const box = document.createElement("button");
  box.type = "button";
  box.className = "cm-lp-task mdbase-checkbox";
  box.dataset.taskFrom = String(from);
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", String(checked));
  const label = checked ? t`Mark task incomplete` : t`Mark task complete`;
  box.setAttribute("aria-label", label);
  box.title = label;
  return box;
}

/** Rendered Markdown: markers hide away from the selection, and lists, tasks and links read as written. */
export function inlinePreview(options: LivePreviewOptions): ViewPlugin<{ decorations: DecorationSet; atomic: DecorationSet }> {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    atomic: DecorationSet;

    constructor(view: EditorView) {
      ({ decorations: this.decorations, atomic: this.atomic } = build(view, options));
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || revealChanged(update)
        || syntaxTree(update.startState) !== syntaxTree(update.state)
        || update.transactions.some((transaction) => transaction.reconfigured)
        || options.refresh?.(update)) {
        ({ decorations: this.decorations, atomic: this.atomic } = build(update.view, options));
      }
    }
  }, {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none)
  });
}

function build(view: EditorView, options: LivePreviewOptions) {
  return buildRanges(view.state, options, view.visibleRanges);
}

function buildRanges(state: EditorState, options: LivePreviewOptions, visibleRanges: readonly { from: number; to: number }[]) {
  const ranges: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const conceal = (from: number, to: number) => {
    if (from >= to) return;
    ranges.push(hide.range(from, to));
    hidden.push(hide.range(from, to));
  };
  const line = (position: number) => state.doc.lineAt(position);
  const lineRevealed = (position: number) => {
    const current = line(position);
    return isRevealed(state, current.from, current.to);
  };

  for (const visible of visibleRanges) {
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        const name = node.name;
        if (name === "Image" || name === "FencedCode" || name === "CodeBlock" || name === "HTMLBlock") return false;

        const heading = /^ATXHeading([1-6])$/.exec(name);
        if (heading) {
          ranges.push(headingLines[Number(heading[1]) - 1].range(line(node.from).from));
          const revealed = lineRevealed(node.from);
          for (const mark of children(node, "HeaderMark")) {
            if (revealed) {
              ranges.push((mark.from === node.from ? headingMark : muted).range(mark.from, mark.to));
            } else {
              // The opening mark takes its space with it; a closing mark the space before it.
              const opening = mark.from === node.from;
              const from = opening ? mark.from : trimStart(state, node.from, mark.from);
              const to = opening ? skipSpaces(state, mark.to, node.to) : mark.to;
              conceal(from, to);
            }
          }
          return;
        }

        if (name in inlineMarks) {
          ranges.push(styles[name].range(node.from, node.to));
          const revealed = isRevealed(state, node.from, node.to);
          for (const mark of children(node, inlineMarks[name])) {
            if (revealed) ranges.push(muted.range(mark.from, mark.to));
            else conceal(mark.from, mark.to);
          }
          return name === "InlineCode" ? false : undefined;
        }

        if (name === "Link") {
          if (/^\[\^[^\]\s]+\]$/.test(state.sliceDoc(node.from, node.to))) return false;
          renderLink(state, node, options, ranges, conceal);
          return false;
        }

        if (name === "URL" && node.node.parent?.name !== "Link" && node.node.parent?.name !== "LinkReference") {
          ranges.push(linkMark(node.from, state.sliceDoc(node.from, node.to), "markdown", false).range(node.from, node.to));
          return;
        }

        if (name === "Escape") {
          if (!isRevealed(state, node.from, node.to)) {
            conceal(node.from, node.from + 1);
            ranges.push(escaped.range(node.from + 1, node.to));
          }
          return;
        }

        if (name === "Blockquote") {
          renderQuote(state, node, ranges);
          return;
        }

        if (name === "QuoteMark") {
          const current = line(node.from);
          if (calloutHeader(current.text)) return;
          if (isRevealed(state, current.from, current.to)) ranges.push(quoteMark.range(node.from, node.to));
          else conceal(node.from, skipSpaces(state, node.to, current.to, 1));
          return;
        }

        if (name === "ListMark") {
          renderListMark(state, node, ranges, hidden);
          return;
        }

        if (name === "HorizontalRule") {
          if (lineRevealed(node.from)) ranges.push(muted.range(node.from, node.to));
          else {
            ranges.push(ruleLine.range(line(node.from).from));
            conceal(node.from, node.to);
          }
          return;
        }
      }
    });
  }
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(hidden, true) };
}

function renderLink(
  state: EditorState,
  node: SyntaxNodeRef,
  options: LivePreviewOptions,
  ranges: Range<Decoration>[],
  conceal: (from: number, to: number) => void
) {
  const url = node.node.getChild("URL");
  // The Markdown grammar reads [[target]] as a Link around [target].
  const wiki = !url && node.from > 0 && state.sliceDoc(node.from - 1, node.from) === "["
    && state.sliceDoc(node.to, node.to + 1) === "]";
  const from = wiki ? node.from - 1 : node.from;
  const to = wiki ? node.to + 1 : node.to;
  const revealed = isRevealed(state, from, to);
  const marks = children(node, "LinkMark");
  if (wiki) {
    const inner = state.sliceDoc(from + 2, to - 2);
    const pipe = inner.indexOf("|");
    const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
    const textFrom = pipe < 0 ? from + 2 : from + 3 + pipe;
    const missing = options.linkMissing?.(state, { from, to, target, format: "wikilink" }) ?? false;
    if (textFrom < to - 2) ranges.push(linkMark(from, target, "wikilink", missing).range(textFrom, to - 2));
    if (revealed) {
      ranges.push(muted.range(from, textFrom));
      ranges.push(muted.range(to - 2, to));
    } else {
      conceal(from, textFrom);
      conceal(to - 2, to);
    }
    return;
  }
  const close = marks.find((mark) => state.sliceDoc(mark.from, mark.to) === "]");
  // A bare [text] is a link only with a matching definition, which a note rarely has.
  if (!close || !marks.length || (!url && !node.node.getChild("LinkLabel"))) return;
  const textFrom = marks[0].to;
  const target = url ? state.sliceDoc(url.from, url.to) : "";
  const missing = url ? options.linkMissing?.(state, { from, to, target, format: "markdown" }) ?? false : false;
  if (textFrom < close.from) ranges.push(linkMark(from, target, "markdown", missing).range(textFrom, close.from));
  if (revealed) {
    ranges.push(muted.range(from, textFrom));
    ranges.push(muted.range(close.from, to));
  } else {
    conceal(from, textFrom);
    // A reference link [text][label] or a bare [text] keeps no trailing source either.
    conceal(close.from, to);
  }
}

function linkMark(from: number, target: string, format: LivePreviewLink["format"], missing: boolean) {
  return Decoration.mark({
    class: missing ? "cm-lp-link cm-lp-link-missing" : "cm-lp-link",
    attributes: {
      role: "link",
      "data-link-from": String(from),
      "data-link-format": format,
      ...(missing ? { title: t`No note or file matches “${target}”.` } : {})
    }
  });
}

function renderQuote(state: EditorState, node: SyntaxNodeRef, ranges: Range<Decoration>[]) {
  if (calloutHeader(state.doc.lineAt(node.from).text)) return;
  // A nested quote's lines belong to its outermost quote, which marks each line's depth.
  if (ancestors(node, "Blockquote") > 1) return;
  const first = state.doc.lineAt(node.from).number;
  const last = state.doc.lineAt(node.to).number;
  for (let number = first; number <= last; number += 1) {
    const current = state.doc.line(number);
    const depth = Math.max(1, (/^\s*((?:>\s?)+)/.exec(current.text)?.[1].match(/>/g) ?? []).length);
    const edge = `${number === first ? " cm-lp-quote-first" : ""}${number === last ? " cm-lp-quote-last" : ""}${depth > 1 ? " cm-lp-quote-nested" : ""}${depth > 2 ? " cm-lp-quote-deep" : ""}`;
    ranges.push(Decoration.line({ class: `cm-lp-quote${edge}`, attributes: { style: `--lp-quote-depth: ${depth}` } }).range(current.from));
  }
}

function renderListMark(state: EditorState, node: SyntaxNodeRef, ranges: Range<Decoration>[], hidden: Range<Decoration>[]) {
  const current = state.doc.lineAt(node.from);
  // Only the item's first line carries its marker.
  if (current.from !== state.doc.lineAt(node.node.parent?.from ?? node.from).from) return;
  const taskMarker = node.node.parent?.getChild("Task")?.getChild("TaskMarker");
  const afterMark = skipSpaces(state, node.to, current.to);
  const task = taskMarker && taskMarker.from === afterMark ? taskMarker : undefined;
  const prefixEnd = task ? skipSpaces(state, task.to, current.to) : afterMark;
  const list = node.node.parent?.parent;
  const marker = state.sliceDoc(node.from, node.to);
  const markerWidth = list?.name === "OrderedList" ? widestMarker(list) : marker.length;
  // A task's checkbox and gap take about the width of its source "[x] ";
  // a bulleted task shows only the checkbox.
  const width = task
    ? node.from - current.from + (/^[-+*]$/.test(marker) ? 0 : markerWidth + 1) + 3.5
    : prefixEnd - current.from + markerWidth - marker.length;
  const checked = task ? /x/i.test(state.sliceDoc(task.from, task.to)) : false;
  // Wrapped lines hang under the item's text: the prefix box is exactly the indent.
  ranges.push(Decoration.line({
    class: checked ? "cm-lp-list cm-lp-task-done" : "cm-lp-list",
    attributes: { style: `--lp-list-indent: ${width}ch` }
  }).range(current.from));
  renderContinuations(state, node.node.parent!, current.to, width, ranges, hidden);
  // The prefix shows its source only while the selection is in it, not at the text after it.
  const revealed = isRevealed(state, node.from, prefixEnd, false);
  if (revealed) {
    ranges.push(Decoration.mark({ class: "cm-lp-list-prefix cm-lp-mark" }).range(current.from, prefixEnd));
    return;
  }
  const widget = Decoration.replace({ widget: new ListPrefixWidget({
    leading: node.from - current.from,
    width,
    marker,
    markerWidth,
    depth: ancestors(node, "BulletList") + ancestors(node, "OrderedList") - 1,
    task: task ? { from: task.from, checked } : undefined
  }) }).range(current.from, prefixEnd);
  ranges.push(widget);
  hidden.push(widget);
}

/** Later lines of an item's own paragraphs hang under its text, whatever their source indent. */
function renderContinuations(state: EditorState, item: SyntaxNode, after: number, width: number, ranges: Range<Decoration>[], hidden: Range<Decoration>[]) {
  const indent = Decoration.line({ class: "cm-lp-list-continue", attributes: { style: `--lp-list-indent: ${width}ch` } });
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if ((child.name !== "Paragraph" && child.name !== "Task") || child.to <= after) continue;
    for (let position = Math.max(child.from, after + 1); position <= child.to;) {
      const current = state.doc.lineAt(position);
      ranges.push(indent.range(current.from));
      const text = skipSpaces(state, current.from, current.to);
      if (text > current.from) {
        const spaces = Decoration.replace({}).range(current.from, text);
        ranges.push(spaces);
        hidden.push(spaces);
      }
      position = current.to + 1;
    }
  }
}

function widestMarker(list: SyntaxNode): number {
  let widest = 0;
  for (let item = list.firstChild; item; item = item.nextSibling) {
    const mark = item.getChild("ListMark");
    if (mark) widest = Math.max(widest, mark.to - mark.from);
  }
  return widest;
}

function children(node: SyntaxNodeRef, name: string) {
  const found: Array<{ from: number; to: number }> = [];
  const cursor = node.node.cursor();
  if (!cursor.firstChild()) return found;
  do if (cursor.name === name) found.push({ from: cursor.from, to: cursor.to }); while (cursor.nextSibling());
  return found;
}

function ancestors(node: SyntaxNodeRef, name: string): number {
  let count = 0;
  for (let current: SyntaxNodeRef["node"] | null = node.node; current; current = current.parent) if (current.name === name) count += 1;
  return count;
}

function skipSpaces(state: EditorState, from: number, limit: number, maximum = Infinity): number {
  let position = from;
  while (position < limit && position - from < maximum && /[ \t]/.test(state.sliceDoc(position, position + 1))) position += 1;
  return position;
}

function trimStart(state: EditorState, limit: number, to: number): number {
  let position = to;
  while (position > limit && /[ \t]/.test(state.sliceDoc(position - 1, position))) position -= 1;
  return position;
}
