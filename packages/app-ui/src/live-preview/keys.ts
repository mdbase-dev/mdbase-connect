import { syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, type ChangeSpec, type EditorState, type Extension, type SelectionRange } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { BlockType, EditorView, keymap } from "@codemirror/view";
import { cellAt, tableAt } from "./table-model.js";

const prefixMarks = new Set(["HeaderMark", "QuoteMark", "ListMark", "TaskMarker"]);

/** Where a line's text starts after its quote, list, task and heading markers. */
function textStart(state: EditorState, position: number): number {
  const line = state.doc.lineAt(position);
  const tree = syntaxTree(state);
  let at = line.from;
  for (;;) {
    while (at < line.to && /[ \t]/.test(state.sliceDoc(at, at + 1))) at += 1;
    const node = tree.resolveInner(at, 1);
    if (at >= line.to || !prefixMarks.has(node.name) || node.from !== at || node.to > line.to) return at;
    at = node.to;
  }
}

/**
 * Home goes to where the line's text starts, as in a word processor, and from
 * there (or from a wrapped row) to the start of the row as usual.
 */
function home(view: EditorView, extend: boolean): boolean {
  const { state } = view;
  view.dispatch(state.update({
    selection: EditorSelection.create(state.selection.ranges.map((range) => {
      const start = textStart(state, range.head);
      const row = view.moveToLineBoundary(range, false);
      const head = range.head > start && row.head <= start ? start : row.head;
      return extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head);
    }), state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "select"
  }));
  return true;
}

/**
 * The first line between `from` and `to`, going `forward` or back, that shows:
 * one with height. Hidden lines, such as a table's delimiter row or a folded
 * callout's body, have none.
 */
function shownLineBetween(view: EditorView, from: number, to: number, forward: boolean) {
  const { doc } = view.state;
  const start = doc.lineAt(from).number, end = doc.lineAt(to).number, step = forward ? 1 : -1;
  for (let number = start + step; forward ? number < end : number > end; number += step) {
    const block = view.lineBlockAt(doc.line(number).from);
    if (block.height > 0) return block;
  }
  return null;
}

/**
 * The next line the caret's table cell shows, going `forward` or back, at `x()`. A row is one line
 * whose cells wrap side by side, and CodeMirror finds where it ends from its last cell's text: when
 * that cell is shorter, Down left the row while the caret's own cell still showed lines below.
 */
function lineInCell(view: EditorView, range: SelectionRange, forward: boolean, x: () => number): number | null {
  const table = tableAt(view.state, range.head);
  const at = table && cellAt(table, range.head);
  const cell = at && table.rows[at.row].cells[at.column];
  const start = cell && view.coordsAtPos(range.head, range.assoc || (forward ? 1 : -1));
  if (!cell || !start) return null;
  const row = view.lineBlockAt(range.head);
  const top = view.documentTop + row.top, bottom = view.documentTop + row.bottom;
  const from = forward ? start.bottom : start.top, step = (forward ? 1 : -1) * view.defaultLineHeight / 2;
  for (let y = from + step; forward ? y < bottom : y > top; y += step) {
    const head = view.posAtCoords({ x: x(), y }, false);
    const coords = head >= cell.contentFrom && head <= cell.contentTo ? view.coordsAtPos(head) : null;
    if (coords && (forward ? coords.top >= from : coords.bottom <= from)) return head;
  }
  return null;
}

/** Where the caret stops on the first line that shows between `from` and `to`, at `x()`. */
function skippedLine(view: EditorView, from: number, to: number, forward: boolean, x: () => number): number | null {
  const block = shownLineBetween(view, from, to, forward);
  if (!block) return null;
  if (block.type !== BlockType.Text) return forward ? block.from : view.state.doc.lineAt(block.to).from;
  const at = view.posAtCoords({ x: x(), y: view.documentTop + (block.top + block.bottom) / 2 }, false);
  return Math.min(Math.max(at, block.from), block.to);
}

/**
 * Up and Down reach every line that shows. CodeMirror's vertical motion steps
 * over rendered blocks and over lines whose end has no position on screen, such
 * as a table row whose closing pipe is hidden, so it jumped past tables, fences,
 * formulas and embeds. Where it would skip such a line, the caret stops there
 * instead: in a table row, in the cell under the caret; on a rendered block, at
 * its source, which then shows. In a table cell whose text wraps, the caret
 * first visits each of the cell's lines.
 */
function lineByLine(view: EditorView, forward: boolean, extend: boolean): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (state.selection.ranges.length > 1 || (!extend && !range.empty)) return false;
  const moved = view.moveVertically(range, forward);
  const line = state.doc.lineAt(range.head);
  if (moved.head >= line.from && moved.head <= line.to) return false;
  const content = view.contentDOM.getBoundingClientRect();
  let goal = moved.goalColumn ?? range.goalColumn;
  const x = () => content.left + (goal ??= (view.coordsAtPos(range.head)?.left ?? content.left) - content.left);
  const head = lineInCell(view, range, forward, x) ?? skippedLine(view, range.head, moved.head, forward, x);
  if (head === null) return false;
  const column = x() - content.left;
  view.dispatch({
    selection: extend ? EditorSelection.range(range.anchor, head, column) : EditorSelection.cursor(head, 0, undefined, column),
    scrollIntoView: true,
    userEvent: "select"
  });
  return true;
}

export const livePreviewKeys: Extension = Prec.high(keymap.of([
  { key: "Home", run: (view) => home(view, false), shift: (view) => home(view, true) },
  { key: "ArrowDown", run: (view) => lineByLine(view, true, false), shift: (view) => lineByLine(view, true, true) },
  { key: "ArrowUp", run: (view) => lineByLine(view, false, false), shift: (view) => lineByLine(view, false, true) }
]));

/** The list item whose marker starts the line at `position`, if any. */
function itemAt(state: EditorState, position: number): SyntaxNode | null {
  const line = state.doc.lineAt(position);
  let at = line.from;
  while (at < line.to && /[ \t]/.test(state.sliceDoc(at, at + 1))) at += 1;
  const mark = syntaxTree(state).resolveInner(at, 1);
  return mark.name === "ListMark" && mark.from === at && mark.parent?.name === "ListItem" ? mark.parent : null;
}

/** The items whose first lines the selection touches, outermost only: an item moves with its children. */
function selectedItems(state: EditorState): SyntaxNode[] {
  const items: SyntaxNode[] = [];
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let number = state.doc.lineAt(range.from).number; number <= last; number += 1) {
      const item = itemAt(state, state.doc.line(number).from);
      if (item && !items.some((other) => other.from <= item.from && item.to <= other.to)) items.push(item);
    }
  }
  return items;
}

function markOf(item: SyntaxNode): SyntaxNode {
  const mark = item.getChild("ListMark");
  if (!mark) throw new Error("A list item has no marker.");
  return mark;
}

function column(state: EditorState, position: number): number {
  return position - state.doc.lineAt(position).from;
}

/** Shift every line of an item, renumbering its marker if it is ordered. */
function shiftItem(state: EditorState, item: SyntaxNode, delta: number, number: number | null): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const last = state.doc.lineAt(item.to).number;
  for (let index = state.doc.lineAt(item.from).number; index <= last; index += 1) {
    const line = state.doc.line(index);
    if (!line.text.trim()) continue;
    const leading = /^[ \t]*/.exec(line.text)![0].length;
    if (delta > 0) changes.push({ from: line.from, insert: " ".repeat(delta) });
    else if (delta < 0) changes.push({ from: line.from, to: line.from + Math.min(leading, -delta) });
  }
  const mark = markOf(item);
  const ordinal = /^(\d+)([.)])$/.exec(state.sliceDoc(mark.from, mark.to));
  if (ordinal && number !== null) changes.push({ from: mark.from, to: mark.to, insert: `${number}${ordinal[2]}` });
  return changes;
}

function ordinalOf(state: EditorState, item: SyntaxNode | null): number | null {
  if (!item) return null;
  const mark = markOf(item);
  const ordinal = /^(\d+)/.exec(state.sliceDoc(mark.from, mark.to));
  return ordinal ? Number(ordinal[1]) : null;
}

/** Tab in a list: nest the item under the one before it, at that item's text column. */
export function indentListItem(view: EditorView): boolean {
  const { state } = view;
  const items = selectedItems(state);
  if (!items.length || state.readOnly) return false;
  const changes = items.flatMap((item) => {
    const previous = item.prevSibling;
    if (previous?.name !== "ListItem") return [];
    const previousMark = markOf(previous);
    let text = previousMark.to;
    while (text < previous.to && text - previousMark.to < 4 && state.sliceDoc(text, text + 1) === " ") text += 1;
    const sublist = previous.lastChild?.name === "OrderedList" ? previous.lastChild : null;
    const number = sublist ? (ordinalOf(state, sublist.lastChild) ?? 0) + 1 : 1;
    return shiftItem(state, item, column(state, text) - column(state, markOf(item).from), number);
  });
  // An item with nothing before it to nest under stays put, and Tab stays in the editor.
  if (changes.length) view.dispatch({ changes, userEvent: "input.indent" });
  return true;
}

/** Shift-Tab in a list: lift the item out to its parent item's column. */
export function outdentListItem(view: EditorView): boolean {
  const { state } = view;
  const items = selectedItems(state);
  if (!items.length || state.readOnly) return false;
  const changes = items.flatMap((item) => {
    const parent = item.parent?.parent;
    if (parent?.name !== "ListItem") return [];
    const parentNumber = ordinalOf(state, parent);
    return shiftItem(state, item, column(state, markOf(parent).from) - column(state, markOf(item).from),
      parentNumber === null ? null : parentNumber + 1);
  });
  if (changes.length) view.dispatch({ changes, userEvent: "delete.dedent" });
  return true;
}
