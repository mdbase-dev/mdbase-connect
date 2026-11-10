import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorSelection, StateEffect, StateField, type ChangeSpec, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

export type TableAlignment = "left" | "center" | "right" | null;

interface TableCell {
  /** Source between two delimiters, including padding. */
  from: number;
  to: number;
  /** The cell's text without its padding; empty cells collapse to one caret stop. */
  contentFrom: number;
  contentTo: number;
}

interface TableRow {
  kind: "header" | "delimiter" | "body";
  /** The row's own source, after any list or quote prefix on its line. */
  from: number;
  to: number;
  lineFrom: number;
  cells: TableCell[];
  trailingPipe: boolean;
}

export interface TableModel {
  from: number;
  to: number;
  /** Header, delimiter, then body rows, in source order. */
  rows: TableRow[];
  columns: number;
  alignments: TableAlignment[];
  /** What a new row's line starts with, so tables in lists and quotes stay there. */
  prefix: string;
}

export interface TablePosition { row: number; column: number }

export interface TableEdit {
  changes: ChangeSpec;
  /** Caret after the edit, in the new document. */
  anchor: number;
  head?: number;
}

/** GFM splits cells on every unescaped pipe, inside code spans too. */
function parseRow(state: EditorState, kind: TableRow["kind"], from: number, to: number): TableRow {
  const text = state.sliceDoc(from, to);
  const pipes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "|") pipes.push(index);
  }
  const leading = text.trimStart().startsWith("|");
  const trailingPipe = pipes.length > 0 && pipes.at(-1) === text.trimEnd().length - 1 && !(pipes.length === 1 && leading);
  const bounds: Array<[number, number]> = [];
  let start = leading ? pipes[0] + 1 : 0;
  for (const pipe of pipes.slice(leading ? 1 : 0)) {
    bounds.push([start, pipe]);
    start = pipe + 1;
  }
  if (!trailingPipe) bounds.push([start, text.trimEnd().length]);
  const cells = bounds.map(([cellFrom, cellTo]) => {
    const source = text.slice(cellFrom, cellTo);
    const trimmed = source.trim();
    let contentFrom = from + cellFrom + (source.length - source.trimStart().length);
    let contentTo = contentFrom + trimmed.length;
    if (!trimmed) contentFrom = contentTo = from + Math.min(cellFrom + 1, cellTo);
    return { from: from + cellFrom, to: from + cellTo, contentFrom, contentTo };
  });
  return { kind, from, to, lineFrom: state.doc.lineAt(from).from, cells, trailingPipe };
}

export function tableModel(state: EditorState, node: SyntaxNode): TableModel {
  const rows: TableRow[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const kind = child.name === "TableHeader" ? "header" : child.name === "TableDelimiter" ? "delimiter" : child.name === "TableRow" ? "body" : null;
    if (kind) rows.push(parseRow(state, kind, child.from, child.to));
  }
  const delimiter = rows.find(row => row.kind === "delimiter")!;
  const alignments = delimiter.cells.map(cell => {
    const value = state.sliceDoc(cell.contentFrom, cell.contentTo);
    const left = value.startsWith(":"), right = value.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
  return {
    from: node.from,
    to: node.to,
    rows,
    columns: rows[0].cells.length,
    alignments,
    prefix: state.sliceDoc(delimiter.lineFrom, delimiter.from)
  };
}

export function tableAt(state: EditorState, position: number): TableModel | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, side); node; node = node.parent) {
      if (node.name === "Table") return tableModel(state, node);
    }
  }
  return null;
}

/** The cell holding a position; padding belongs to the nearest cell. Null on the delimiter row. */
export function cellAt(table: TableModel, position: number): TablePosition | null {
  const row = table.rows.findIndex(row => position >= row.lineFrom && position <= row.to);
  if (row < 0 || table.rows[row].kind === "delimiter") return null;
  const cells = table.rows[row].cells;
  let column = cells.findIndex(cell => position <= cell.to);
  if (column < 0) column = cells.length - 1;
  return { row, column: Math.max(0, column) };
}

function bodyRows(table: TableModel): number[] {
  return table.rows.flatMap((row, index) => row.kind === "body" ? [index] : []);
}

function rowLine(table: TableModel, cells: string[]): string {
  return `${table.prefix}| ${cells.join(" | ")} |`;
}

/** The first content position of a freshly written row starting at `lineFrom`. */
function firstCell(table: TableModel, lineFrom: number) {
  return lineFrom + table.prefix.length + 2;
}

function emptyCells(table: TableModel) {
  return Array<string>(table.columns).fill("");
}

/** Writes a row's text as it is, without escaping: callers own their cells' Markdown. */
export function insertRow(table: TableModel, after: number, cells = emptyCells(table)): TableEdit {
  // Rows are never added above the header or between it and the delimiter.
  const anchorRow = table.rows[Math.max(after, 1)];
  const at = anchorRow.to;
  const lineFrom = at + 1;
  return { changes: { from: at, insert: `\n${rowLine(table, cells)}` }, anchor: firstCell(table, lineFrom) + (cells[0]?.length ?? 0) };
}

/** Deletes body rows; the header and delimiter stay. */
export function deleteRows(table: TableModel, rows: readonly number[]): TableEdit | null {
  const targets = rows.filter(row => table.rows[row]?.kind === "body").sort((a, b) => a - b);
  if (!targets.length) return null;
  const changes = targets.map(row => ({ from: table.rows[row - 1].to, to: table.rows[row].to }));
  // The caret goes to the first cell of the row that takes their place.
  const before = table.rows[targets[0] - 1];
  const destination = table.rows[targets.at(-1)! + 1] ?? (before.kind === "body" ? before : table.rows[0]);
  const position = destination.cells[0]?.contentTo ?? destination.to;
  return { changes, anchor: position - changes.reduce((removed, change) => removed + (change.to <= position ? change.to - change.from : 0), 0) };
}

function cellText(state: EditorState, cell: TableCell | undefined) {
  return cell ? state.sliceDoc(cell.contentFrom, cell.contentTo) : "";
}

/** Rewrites each row's cells, keeping its prefix; used by column edits so every row agrees. */
function rewriteRows(state: EditorState, table: TableModel, map: (cells: string[], row: TableRow) => string[]): ChangeSpec[] {
  return table.rows.map(row => {
    const cells = Array.from({ length: Math.max(row.cells.length, row.kind === "body" ? 0 : table.columns) }, (_, index) => cellText(state, row.cells[index]));
    return { from: row.from, to: row.to, insert: `| ${map(cells, row).join(" | ")} |` };
  });
}

function delimiterCell(alignment: TableAlignment) {
  return alignment === "center" ? ":---:" : alignment === "right" ? "---:" : alignment === "left" ? ":---" : "---";
}

/** Position of a column's content after a column edit rewrote every row. */
function rewrittenCell(state: EditorState, table: TableModel, rowIndex: number, column: number, map: (cells: string[], row: TableRow) => string[]) {
  let offset = 0;
  for (let index = 0; index < rowIndex; index++) {
    const row = table.rows[index];
    const cells = Array.from({ length: Math.max(row.cells.length, row.kind === "body" ? 0 : table.columns) }, (_, cell) => cellText(state, row.cells[cell]));
    offset += `| ${map(cells, row).join(" | ")} |`.length - (row.to - row.from);
  }
  const row = table.rows[rowIndex];
  const cells = map(Array.from({ length: Math.max(row.cells.length, row.kind === "body" ? 0 : table.columns) }, (_, cell) => cellText(state, row.cells[cell])), row);
  let position = row.from + offset + 2;
  for (let index = 0; index < Math.min(column, cells.length); index++) position += cells[index].length + 3;
  return position + (cells[column]?.length ?? 0);
}

function columnEdit(state: EditorState, table: TableModel, at: TablePosition, column: number, map: (cells: string[], row: TableRow) => string[]): TableEdit {
  return { changes: rewriteRows(state, table, map), anchor: rewrittenCell(state, table, at.row, column, map) };
}

export function insertColumn(state: EditorState, table: TableModel, at: TablePosition, index: number): TableEdit {
  return columnEdit(state, table, at, index, (cells, row) => {
    if (row.kind === "body" && cells.length < index) return cells;
    const next = cells.slice();
    next.splice(index, 0, row.kind === "delimiter" ? "---" : "");
    return next;
  });
}

/** Deletes columns, keeping at least one. */
export function deleteColumns(state: EditorState, table: TableModel, at: TablePosition, columns: readonly number[]): TableEdit | null {
  if (columns.length >= table.columns) return null;
  return columnEdit(state, table, at, Math.min(Math.min(...columns), table.columns - columns.length - 1), cells => cells.filter((_, index) => !columns.includes(index)));
}

/** Moves a column to another index; every row is rewritten so short rows keep their place. */
export function moveColumn(state: EditorState, table: TableModel, at: TablePosition, target: number): TableEdit | null {
  if (target < 0 || target >= table.columns || target === at.column) return null;
  return columnEdit(state, table, at, target, cells => {
    const next = cells.slice();
    while (next.length <= Math.max(at.column, target)) next.push("");
    next.splice(target, 0, ...next.splice(at.column, 1));
    return next;
  });
}

export function alignColumn(state: EditorState, table: TableModel, at: TablePosition, alignment: TableAlignment): TableEdit {
  const cell = table.rows[1].cells[at.column];
  const insert = delimiterCell(alignment);
  const delta = insert.length - (cell.contentTo - cell.contentFrom);
  const head = state.selection.main.head;
  // Only the delimiter row changes, so the caret stays where it was.
  return { changes: { from: cell.contentFrom, to: cell.contentTo, insert }, anchor: head > cell.contentTo ? head + delta : head };
}

/** Writes body rows in a new order; the caret stays on the row it was in. */
function reorderRows(state: EditorState, table: TableModel, order: TableRow[]): TableEdit {
  const rows = bodyRows(table).map(index => table.rows[index]);
  const first = rows[0], last = rows.at(-1)!;
  const separator = `\n${state.sliceDoc(first.lineFrom, first.from)}`;
  const head = state.selection.main.head;
  let anchor = head, at = first.from;
  for (const row of order) {
    if (head >= row.from && head <= row.to) anchor = at + head - row.from;
    at += row.to - row.from + separator.length;
  }
  return {
    changes: { from: first.from, to: last.to, insert: order.map(row => state.sliceDoc(row.from, row.to)).join(separator) },
    anchor
  };
}

/** Moves a body row to another body row's index. */
export function moveRow(state: EditorState, table: TableModel, row: number, target: number): TableEdit | null {
  if (table.rows[row]?.kind !== "body" || table.rows[target]?.kind !== "body" || row === target) return null;
  const order = bodyRows(table).map(index => table.rows[index]);
  const first = bodyRows(table)[0];
  order.splice(target - first, 0, ...order.splice(row - first, 1));
  return reorderRows(state, table, order);
}

/** Sorts body rows by one column; blank cells stay last. */
export function sortRows(state: EditorState, table: TableModel, column: number, direction: 1 | -1): TableEdit | null {
  const rows = bodyRows(table).map(index => table.rows[index]);
  if (rows.length < 2) return null;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const keyed = rows.map(row => ({ row, key: cellText(state, row.cells[column]).trim() }));
  keyed.sort((a, b) => !a.key || !b.key ? Number(!a.key) - Number(!b.key) : direction * collator.compare(a.key, b.key));
  return reorderRows(state, table, keyed.map(({ row }) => row));
}

/** Text typed or pasted into one cell cannot end the cell or the row. */
export function escapeCell(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\\?\|/g, pipe => pipe.length === 2 ? pipe : "\\|").replace(/\n/g, "<br>");
}

/** Clipboard grids: spreadsheet tab-separated text, or rows of a Markdown table. */
export function parseGrid(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.every(line => /^\s*\|.*\|\s*$/.test(line))) {
    return lines
      .filter(line => !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line))
      .map(line => {
        const cells: string[] = [];
        let current = "";
        const body = line.trim().replace(/^\|/, "");
        for (let index = 0; index < body.length; index++) {
          if (body[index] === "\\" && index + 1 < body.length) { current += body.slice(index, index + 2); index++; }
          else if (body[index] === "|") { cells.push(current.trim()); current = ""; }
          else current += body[index];
        }
        if (current.trim()) cells.push(current.trim());
        return cells;
      });
  }
  if (!text.includes("\t")) return null;
  return lines.map(line => line.split("\t").map(cell => escapeCell(cell.trim())));
}

/** Fills cells from a position, adding rows and columns the grid needs. */
export function pasteGrid(state: EditorState, table: TableModel, at: TablePosition, grid: string[][]): TableEdit {
  const width = Math.max(table.columns, at.column + Math.max(...grid.map(row => row.length)));
  const startRow = Math.max(at.row, 0);
  const rows: string[][] = table.rows.map(row => Array.from({ length: row.kind === "body" ? row.cells.length : table.columns }, (_, index) => cellText(state, row.cells[index])));
  for (let index = rows.length; index < startRow + grid.length + (startRow === 0 ? 1 : 0); index++) rows.push(Array<string>(width).fill(""));
  grid.forEach((values, offset) => {
    // The delimiter row is never a paste target.
    const target = startRow + offset + (startRow === 0 && offset > 0 ? 1 : 0);
    values.forEach((value, column) => {
      const cells = rows[target];
      while (cells.length < at.column + column) cells.push("");
      cells[at.column + column] = value;
    });
  });
  rows[1] = Array.from({ length: width }, (_, index) => table.rows[1].cells[index] ? cellText(state, table.rows[1].cells[index]) : "---");
  rows[0] = Array.from({ length: width }, (_, index) => rows[0][index] ?? "");
  const lines = rows.map((cells, index) => index < table.rows.length
    ? `${state.sliceDoc(table.rows[index].lineFrom, table.rows[index].from)}| ${cells.join(" | ")} |`
    : `${table.prefix}| ${cells.join(" | ")} |`);
  const first = table.rows[0];
  const last = grid.at(-1)!;
  const lastRow = startRow + grid.length - 1 + (startRow === 0 && grid.length > 1 ? 1 : 0);
  let anchor = first.lineFrom;
  for (let index = 0; index < lastRow; index++) anchor += lines[index].length + 1;
  const lastColumn = at.column + last.length - 1;
  anchor += (index => {
    const prefix = index < table.rows.length ? table.rows[index].from - table.rows[index].lineFrom : table.prefix.length;
    return prefix + 2 + rows[index].slice(0, lastColumn + 1).reduce((sum, cell) => sum + cell.length + 3, 0) - 3;
  })(lastRow);
  return { changes: { from: first.lineFrom, to: table.rows.at(-1)!.to, insert: lines.join("\n") }, anchor };
}

/** A pipe-delimited line that is about to become a table header. */
export function headerCells(text: string): string[] | null {
  const trimmed = text.trim();
  if (!/^\|.*\|$/.test(trimmed) || trimmed.length < 3) return null;
  const cells = trimmed.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
  return cells.length && cells.some(Boolean) ? cells : null;
}

/** Marks a table edit that already keeps every row well formed. */
export const tableEdit = Annotation.define<boolean>();

export function dispatchTableEdit(view: EditorView, edit: TableEdit | null, userEvent = "input.table"): boolean {
  if (!edit) return false;
  if (view.state.readOnly) return true;
  view.dispatch({
    changes: edit.changes,
    selection: EditorSelection.single(edit.anchor, edit.head ?? edit.anchor),
    annotations: tableEdit.of(true),
    scrollIntoView: true,
    userEvent
  });
  return true;
}

/** A block of cells: a selection running from one cell into another of the same table. */
export interface CellRange { table: TableModel; anchor: TablePosition; head: TablePosition }

type Corners = Pick<CellRange, "anchor" | "head">;

const setCorners = StateEffect.define<Corners>();

/**
 * A block's corners, set with the selection that spans it. A row shorter than its header
 * has no text in its missing cells, so the selection alone cannot end a block there.
 */
export const cellCorners = StateField.define<Corners | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setCorners)) return effect.value;
    return transaction.selection || transaction.docChanged ? null : value;
  }
});

/** The cell a position belongs to; the delimiter row counts as the header, and hidden overflow as the last column. */
function cellOf(table: TableModel, position: number): TablePosition {
  let row = 0;
  table.rows.forEach((candidate, index) => { if (candidate.lineFrom <= position) row = index; });
  const cells = table.rows[row].cells;
  const column = cells.findIndex(cell => position <= cell.to);
  return { row: table.rows[row].kind === "delimiter" ? 0 : row, column: Math.max(0, Math.min(column < 0 ? cells.length - 1 : column, table.columns - 1)) };
}

export function cellRange(state: EditorState): CellRange | null {
  if (state.selection.ranges.length !== 1 || state.selection.main.empty) return null;
  const { anchor, head, from, to } = state.selection.main;
  const table = tableAt(state, head);
  if (!table || from < table.rows[0].lineFrom || to > table.to) return null;
  // A selection ending at a row's start ends with the row before, as whole rows do.
  const corners = state.field(cellCorners, false);
  if (corners && corners.anchor.row < table.rows.length && corners.head.row < table.rows.length) return { table, ...corners };
  const end = (position: number) => position === to && table.rows.some(row => row.lineFrom === position) ? position - 1 : position;
  const range = { table, anchor: cellOf(table, end(anchor)), head: cellOf(table, end(head)) };
  return range.anchor.row === range.head.row && range.anchor.column === range.head.column ? null : range;
}

/** Row indexes and columns a range covers, top-left first; the delimiter row is never one of them. */
export function rangeCells(range: CellRange) {
  const rows = range.table.rows.flatMap((row, index) => row.kind !== "delimiter" && index >= Math.min(range.anchor.row, range.head.row) && index <= Math.max(range.anchor.row, range.head.row) ? [index] : []);
  const left = Math.min(range.anchor.column, range.head.column), right = Math.max(range.anchor.column, range.head.column);
  return { rows, columns: Array.from({ length: right - left + 1 }, (_, index) => left + index) };
}

/** The selection for a block of cells, spanning from the anchor cell's text to the head cell's. */
export function selectCells(table: TableModel, anchor: TablePosition, head: TablePosition): { selection: EditorSelection; effects: StateEffect<Corners> } {
  const forward = head.row > anchor.row || (head.row === anchor.row && head.column >= anchor.column);
  const edge = (at: TablePosition, end: boolean) => {
    const cell = table.rows[at.row].cells[at.column];
    return cell ? (end ? cell.contentTo : cell.contentFrom) : table.rows[at.row].to;
  };
  return { selection: EditorSelection.single(edge(anchor, !forward), edge(head, forward)), effects: setCorners.of({ anchor, head }) };
}

/** Empties every cell in a range; the pipes and padding stay. */
export function clearCells(state: EditorState, range: CellRange): ChangeSpec[] {
  const { rows, columns } = rangeCells(range);
  return rows.flatMap(row => columns.flatMap(column => {
    const cell = range.table.rows[row].cells[column];
    return cell && cell.contentTo > cell.contentFrom && state.sliceDoc(cell.contentFrom, cell.contentTo).trim() ? [{ from: cell.contentFrom, to: cell.contentTo }] : [];
  }));
}

/** Empties a block's cells, leaving it selected. */
export function clearBlock(state: EditorState, range: CellRange, userEvent?: string): TransactionSpec | null {
  const changes = state.changes(clearCells(state, range));
  if (changes.empty) return null;
  const { main } = state.selection;
  return {
    changes,
    selection: EditorSelection.single(changes.mapPos(main.anchor), changes.mapPos(main.head)),
    effects: setCorners.of({ anchor: range.anchor, head: range.head }),
    annotations: tableEdit.of(true),
    userEvent,
    scrollIntoView: true
  };
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A cell's common inline Markdown as HTML, so spreadsheets and documents get formatting, not markers. */
function cellHtml(markdown: string): string {
  return markdown.split(/<br\s*\/?>/i).map(part => escapeHtml(part.replace(/\\\|/g, "|"))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, star, line) => `<strong>${star ?? line}</strong>`)
    .replace(/(?<![*\w])\*([^*]+)\*(?!\*)|(?<![_\w])_([^_]+)_(?![_\w])/g, (_, star, line) => `<em>${star ?? line}</em>`)
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label ?? target)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')).join("<br>");
}

/**
 * A range as the clipboard carries it: Markdown rows for text editors and our own tables,
 * an HTML table for spreadsheets and documents. With the header included, the Markdown is a whole table.
 */
export function cellClipboard(state: EditorState, range: CellRange): { markdown: string; html: string } {
  const { rows, columns } = rangeCells(range);
  const values = rows.map(row => columns.map(column => cellText(state, range.table.rows[row].cells[column])));
  const lines = values.map(cells => `| ${cells.join(" | ")} |`);
  if (rows[0] === 0) lines.splice(1, 0, `| ${columns.map(column => delimiterCell(range.table.alignments[column])).join(" | ")} |`);
  const html = values.map((cells, index) => {
    const tag = rows[index] === 0 ? "th" : "td";
    return `<tr>${cells.map(cell => `<${tag}>${cellHtml(cell)}</${tag}>`).join("")}</tr>`;
  });
  const head = rows[0] === 0 ? `<thead>${html.shift()}</thead>` : "";
  return { markdown: lines.join("\n"), html: `<table>${head}<tbody>${html.join("")}</tbody></table>` };
}

/** The whole table as a range. */
export function wholeTable(table: TableModel): CellRange {
  return { table, anchor: { row: 0, column: 0 }, head: { row: table.rows.length - 1, column: table.columns - 1 } };
}

interface TableContext { table: TableModel; at: TablePosition }

export function tableContext(state: EditorState): TableContext | null {
  if (state.selection.ranges.length !== 1) return null;
  const { head, anchor } = state.selection.main;
  const table = tableAt(state, head);
  if (!table || Math.min(head, anchor) < table.rows[0].lineFrom || Math.max(head, anchor) > table.to) return null;
  const at = cellAt(table, head);
  return at ? { table, at } : null;
}

