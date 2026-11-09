import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Prec, RangeSet, Transaction, type ChangeSpec, type Extension, type Range, type TransactionSpec } from "@codemirror/state";
import { BlockWrapper, Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type MouseSelectionStyle, type ViewUpdate } from "@codemirror/view";
import { isRevealed, revealChanged } from "./reveal.js";
import {
  cellAt, cellClipboard, cellCorners, cellRange, clearBlock, clearCells, dispatchTableEdit, escapeCell, headerCells, insertRow, moveRow, parseGrid, pasteGrid, rangeCells,
  selectCells, tableAt, tableContext, tableEdit, tableModel, wholeTable, type CellRange, type TableModel, type TablePosition
} from "./table-model.js";
import { cellTarget, tableControls } from "./table-controls.js";


class EmptyCell extends WidgetType {
  constructor(readonly filler: boolean, readonly className: string) { super(); }
  eq(other: EmptyCell) { return other.filler === this.filler && other.className === this.className; }
  toDOM() {
    const cell = document.createElement("span");
    cell.className = this.className;
    // A row shorter than its header is padded; a click there materializes the cell.
    if (this.filler) cell.dataset.lpFill = "";
    else cell.dataset.lpEmpty = "";
    return cell;
  }
  ignoreEvent() { return false; }
}

class LineBreak extends WidgetType {
  eq() { return true; }
  toDOM() { return document.createElement("br"); }
}

const hide = Decoration.replace({});
const lineBreak = Decoration.replace({ widget: new LineBreak() });
const grid = BlockWrapper.create({ tagName: "div", attributes: { class: "cm-lp-table" }, rank: 0 });
// While a block of cells is selected, the text selection under it is not drawn.
const gridWithCells = BlockWrapper.create({ tagName: "div", attributes: { class: "cm-lp-table cm-lp-table-cells" }, rank: 0 });

/** The frame carries what the rows' lines would have: a list's indent or a quote's fill. */
function frame(state: EditorState, table: TableModel, last: number) {
  const quotes = (table.prefix.match(/>/g) ?? []).length;
  const indent = table.prefix.replace(/>\s?/g, "").replace(/\t/g, "    ").length;
  let className = "cm-lp-table-frame";
  if (quotes) {
    className += " cm-lp-table-quote";
    // The quote's last line may be the table's: then the frame closes the fill.
    const next = last < state.doc.lines ? state.doc.line(last + 1).text : "";
    if (!/^\s*>/.test(next)) className += " cm-lp-table-quote-last";
  }
  return BlockWrapper.create({ tagName: "div", rank: 1, attributes: { class: className, style: `--lp-table-indent: ${indent}ch; --lp-quote-depth: ${quotes}` } });
}

function cellClass(table: TableModel, row: number, column: number, active: boolean, selected: boolean) {
  const alignment = table.alignments[column];
  return `cm-lp-td${table.rows[row].kind === "header" ? " cm-lp-th" : ""}${alignment && alignment !== "left" ? ` cm-lp-align-${alignment}` : ""}${active ? " cm-lp-td-active" : ""}${selected ? " cm-lp-td-selected" : ""}`;
}

interface Built { decorations: DecorationSet; cells: DecorationSet; atomic: RangeSet<Decoration>; wrappers: RangeSet<BlockWrapper> }

function build(view: EditorView): Built {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const cells: Range<Decoration>[] = [];
  const atomic: Array<[number, number]> = [];
  const stops = new Set<number>();
  const wrappers: Range<BlockWrapper>[] = [];
  const head = state.selection.main.head;
  const range = cellRange(state);
  const block = range && rangeCells(range);
  let seen = -1;
  for (const visible of view.visibleRanges) {
    syntaxTree(state).iterate({ from: visible.from, to: visible.to, enter(node) {
      if (node.name !== "Table") return;
      if (node.from <= seen) return false;
      seen = node.from;
      const table = tableModel(state, node.node);
      const selecting = range?.table.from === table.from ? block : null;
      // Typing over a block of cells starts in its anchor, so that is the active cell.
      const active = !view.hasFocus ? null : selecting ? range!.anchor : head >= table.rows[0].lineFrom && head <= table.to ? cellAt(table, head) : null;
      wrappers.push(frame(state, table, state.doc.lineAt(table.to).number).range(table.rows[0].lineFrom, table.to));
      wrappers.push((selecting ? gridWithCells : grid).range(table.rows[0].lineFrom, table.to));
      table.rows.forEach((row, rowIndex) => {
        const kinds = `cm-lp-tr cm-lp-tr-${row.kind}${rowIndex === table.rows.length - 1 ? " cm-lp-tr-last" : ""}`;
        decorations.push(Decoration.line({ class: kinds }).range(row.lineFrom));
        if (rowIndex > 0) atomic.push([table.rows[rowIndex - 1].to, row.from]);
        if (row.kind === "delimiter") {
          if (row.to > row.from) decorations.push(hide.range(row.from, row.to));
          atomic.push([row.from, row.to]);
          return;
        }
        let hiddenFrom = row.from;
        const hideTo = (to: number) => {
          if (to > hiddenFrom) decorations.push(hide.range(hiddenFrom, to));
          if (to >= hiddenFrom) atomic.push([hiddenFrom, to]);
        };
        for (let column = 0; column < table.columns; column++) {
          const cell = row.cells[column];
          const className = cellClass(table, rowIndex, column, active?.row === rowIndex && active.column === column,
            !!selecting && selecting.rows.includes(rowIndex) && selecting.columns.includes(column));
          if (!cell) {
            cells.push(Decoration.widget({ widget: new EmptyCell(true, className), side: 1 }).range(row.to));
            continue;
          }
          // A space typed at the end of a cell is padding until text follows it. While the caret
          // sits after it, it shows: hidden, the caret would land in the next cell.
          const editing = !range && active?.row === rowIndex && active.column === column && head > cell.contentTo && head <= cell.to;
          const end = editing ? head : cell.contentTo;
          hideTo(cell.contentFrom);
          if (cell.contentFrom === end) {
            stops.add(cell.contentFrom);
            cells.push(Decoration.widget({ widget: new EmptyCell(false, className), side: 1 }).range(cell.contentFrom));
          } else {
            cells.push(Decoration.mark({ class: className, inclusive: true }).range(cell.contentFrom, end));
            const revealed = active?.row === rowIndex && active.column === column && view.hasFocus;
            const text = state.sliceDoc(cell.contentFrom, cell.contentTo);
            for (const match of text.matchAll(/<br\s*\/?>/gi)) {
              const from = cell.contentFrom + match.index;
              if (!revealed || !isRevealed(state, from, from + match[0].length)) decorations.push(lineBreak.range(from, from + match[0].length));
            }
          }
          hiddenFrom = end;
        }
        // Cells past the header's width are not part of the table.
        hideTo(row.to);
      });
    } });
  }
  atomic.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [from, to] of atomic) {
    const last = merged.at(-1);
    // Touching ranges merge, except at an empty cell's only caret stop.
    if (last && (from < last[1] || (from === last[1] && !stops.has(from)))) last[1] = Math.max(last[1], to);
    else if (to > from) merged.push([from, to]);
  }
  return {
    decorations: Decoration.set(decorations, true),
    cells: Decoration.set(cells, true),
    atomic: RangeSet.of(merged.map(([from, to]) => hide.range(from, to))),
    wrappers: BlockWrapper.set(wrappers, true)
  };
}

const tableView = ViewPlugin.fromClass(class {
  built: Built;
  constructor(view: EditorView) { this.built = build(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || revealChanged(update)
      || syntaxTree(update.startState) !== syntaxTree(update.state)) this.built = build(update.view);
  }
}, {
  provide: plugin => [
    EditorView.decorations.of(view => view.plugin(plugin)?.built.decorations ?? Decoration.none),
    // Cells must be the line's direct children for table layout, outside every inline mark.
    EditorView.outerDecorations.of(view => view.plugin(plugin)?.built.cells ?? Decoration.none),
    EditorView.atomicRanges.of(view => view.plugin(plugin)?.built.atomic ?? RangeSet.empty),
    EditorView.blockWrappers.of(view => view.plugin(plugin)?.built.wrappers ?? RangeSet.empty)
  ]
});

function cellSelection(view: EditorView, table: TableModel, row: number, column: number, select: boolean) {
  const cell = table.rows[row].cells[column];
  if (!cell) {
    // GFM pads short rows. Materialize only the missing cells someone edits.
    const target = table.rows[row];
    const missing = column - target.cells.length + 1;
    const insert = `${target.trailingPipe ? "" : " |"}${"  |".repeat(missing)}`;
    return dispatchTableEdit(view, { changes: { from: target.to, insert }, anchor: target.to + insert.length - 2 }, "input.table");
  }
  view.dispatch({ selection: EditorSelection.single(select ? cell.contentFrom : cell.contentTo, cell.contentTo), scrollIntoView: true, userEvent: "select" });
  return true;
}

function nextCell(view: EditorView, direction: 1 | -1): boolean {
  const context = tableContext(view.state);
  if (!context) return false;
  const { table, at } = context;
  const order = table.rows.flatMap((row, index) => row.kind === "delimiter" ? [] : [index]);
  let position = order.indexOf(at.row) * table.columns + at.column + direction;
  if (position < 0) return true;
  if (position >= order.length * table.columns) {
    // Tab past the last cell adds a row, as in a spreadsheet.
    return dispatchTableEdit(view, insertRow(table, table.rows.length - 1));
  }
  return cellSelection(view, table, order[Math.floor(position / table.columns)], position % table.columns, true);
}

function isEmptyRow(state: EditorState, table: TableModel, row: number) {
  return table.rows[row].cells.every(cell => cell.contentFrom === cell.contentTo || !state.sliceDoc(cell.contentFrom, cell.contentTo).trim());
}

function enter(view: EditorView): boolean {
  const context = tableContext(view.state);
  if (!context) return startTable(view);
  const { table, at } = context;
  const first = table.rows[0];
  if (at.row === 0 && at.column === 0 && view.state.selection.main.empty && view.state.selection.main.head <= (first.cells[0]?.contentFrom ?? first.from)) {
    // At the table's very start, Enter opens a line above it, as in a word processor: otherwise
    // a table at the top of a note, or straight after another block, has nothing in front of it.
    const prefix = view.state.sliceDoc(first.lineFrom, first.from).trimEnd();
    return dispatchTableEdit(view, { changes: { from: first.lineFrom, insert: `${prefix}\n` }, anchor: first.lineFrom + prefix.length });
  }
  const last = table.rows.length - 1;
  if (at.row === last && table.rows[last].kind === "body" && isEmptyRow(view.state, table, last)) {
    // Enter on an empty last row leaves the table, like an empty list item.
    // In GFM a line straight after a table joins it, so the caret lands past a blank line.
    const { doc } = view.state;
    const row = doc.lineAt(table.to);
    const next = row.number < doc.lines ? doc.line(row.number + 1) : null;
    const insert = next && next.text.trim() ? "\n\n\n" : "\n\n";
    const previous = table.rows[last - 1];
    return dispatchTableEdit(view, { changes: { from: previous.to, to: row.to, insert }, anchor: previous.to + 2 });
  }
  if (at.row < last) {
    const row = at.row === 0 ? 2 : at.row + 1;
    if (row <= last) return cellSelection(view, table, row, at.column, false);
  }
  const edit = insertRow(table, at.row);
  return dispatchTableEdit(view, { ...edit, anchor: edit.anchor + 3 * at.column });
}

function insertBelow(view: EditorView): boolean {
  const context = tableContext(view.state);
  if (!context) return false;
  const edit = insertRow(context.table, context.at.row);
  return dispatchTableEdit(view, { ...edit, anchor: edit.anchor + 3 * context.at.column });
}

/** `| a | b |` then Enter writes the delimiter and a first row. */
function startTable(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty || state.selection.ranges.length !== 1) return false;
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false;
  const pipe = line.text.indexOf("|");
  if (pipe < 0) return false;
  const before = line.text.slice(0, pipe);
  if (!/^[\s>]*$/.test(before)) return false;
  const cells = headerCells(line.text.slice(pipe));
  const node = syntaxTree(state).resolveInner(line.from, 1);
  if (!cells || node.name !== "Paragraph" && node.name !== "Document" && node.name !== "Blockquote") return false;
  if (line.number > 1 && state.doc.line(line.number - 1).text.trim() && !/^[\s>]*$/.test(state.doc.line(line.number - 1).text)) return false;
  const delimiter = `${before}| ${cells.map(() => "---").join(" | ")} |`;
  const row = `${before}| ${cells.map(() => "").join(" | ")} |`;
  const anchor = line.to + 1 + delimiter.length + 1 + before.length + 2;
  return dispatchTableEdit(view, { changes: { from: line.to, insert: `\n${delimiter}\n${row}` }, anchor });
}

function cellBoundary(view: EditorView, side: -1 | 1, extend: boolean): boolean {
  const context = tableContext(view.state);
  if (!context) return false;
  const cell = context.table.rows[context.at.row].cells[context.at.column];
  if (!cell) return false;
  const target = side < 0 ? cell.contentFrom : cell.contentTo;
  const { anchor, head } = view.state.selection.main;
  if (head === target && !extend) return false;
  view.dispatch({ selection: EditorSelection.single(extend ? anchor : target, target), scrollIntoView: true, userEvent: "select" });
  return true;
}

function backspaceRow(view: EditorView): boolean {
  const context = tableContext(view.state);
  if (!context || !view.state.selection.main.empty) return false;
  const { table, at } = context;
  const cell = table.rows[at.row].cells[at.column];
  if (at.column !== 0 || !cell || view.state.selection.main.head !== cell.contentFrom) return false;
  // An empty row goes away from its first cell, like an empty list item.
  if (table.rows[at.row].kind === "body" && isEmptyRow(view.state, table, at.row)) {
    const previous = table.rows[at.row - 1];
    const target = previous.kind === "delimiter" ? table.rows[0] : previous;
    const last = target.cells[Math.min(target.cells.length, table.columns) - 1];
    return dispatchTableEdit(view, { changes: { from: previous.to, to: table.rows[at.row].to }, anchor: last?.contentTo ?? target.to }, "delete.table");
  }
  return true;
}

function shiftRow(view: EditorView, direction: -1 | 1): boolean {
  const context = tableContext(view.state);
  if (!context) return false;
  return dispatchTableEdit(view, moveRow(view.state, context.table, context.at.row, context.at.row + direction), "move.table") || true;
}

const segments = (table: TableModel) => table.rows.flatMap(row => row.kind === "delimiter" ? [] : row.cells.slice(0, table.columns));

/** Keeps typing, deleting, cutting and dropping inside cells, so no edit breaks a row apart. */
function protectRows(transaction: Transaction): TransactionSpec | readonly TransactionSpec[] {
  if (!transaction.docChanged || transaction.annotation(tableEdit)
    || !(transaction.isUserEvent("input") || transaction.isUserEvent("delete") || transaction.isUserEvent("move"))) return transaction;
  const state = transaction.startState;
  const range = cellRange(state);
  if (range && !wholeRows(state, range.table)) return replaceCells(transaction, range);
  const changes: ChangeSpec[] = [];
  let rewritten = false;
  let caret: number | null = null;
  let caretText = 0;
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    const table = tableAt(state, fromA) ?? (toA > fromA ? tableAt(state, toA) : null);
    const start = table?.rows[0].lineFrom ?? 0;
    if (!table || toA < start || fromA > table.to) {
      changes.push({ from: fromA, to: toA, insert: text });
      return;
    }
    const rowStarts = new Set(table.rows.map(row => row.lineFrom));
    const rowEnds = new Set(table.rows.map(row => row.to));
    // Whole rows, or the whole table, go as people selected them.
    const whole = (rowStarts.has(fromA) || fromA === start) && (rowStarts.has(toA) || toA === table.to + 1 || (toA === table.to && fromA === start))
      || (rowEnds.has(fromA) && (rowEnds.has(toA) || toA === table.to)) && toA > fromA && !text;
    if (whole) {
      changes.push({ from: fromA, to: toA, insert: text });
      return;
    }
    const cells = segments(table);
    const inside = cells.find(cell => fromA >= cell.from && toA <= cell.to);
    const escaped = escapeCell(text);
    if (inside && escaped === text) {
      changes.push({ from: fromA, to: toA, insert: text });
      return;
    }
    rewritten = true;
    const touched = cells.filter(cell => cell.to >= fromA && cell.from <= toA);
    // Across cells, only text goes: padding and pipes stay, so a row never loses a column.
    for (const cell of touched) {
      const from = inside ? fromA : Math.max(cell.contentFrom, fromA), to = inside ? toA : Math.min(cell.contentTo, toA);
      if (to > from) changes.push({ from, to });
    }
    if (escaped) {
      // Text typed on structure lands in the nearest cell's content.
      const target = inside ?? touched[0] ?? cells.find(cell => cell.from >= fromA) ?? cells.at(-1)!;
      const at = inside ? fromA : Math.max(target.contentFrom, Math.min(fromA, target.contentTo));
      changes.push({ from: at, insert: escaped });
      caret = at;
      caretText = escaped.length;
    } else caret = touched[0] ? Math.max(touched[0].contentFrom, fromA) : fromA;
  });
  if (!rewritten) return transaction;
  const set = state.changes(changes);
  // Deleting only structure, such as Backspace at a cell's start, does nothing.
  if (set.empty) return {};
  const anchor = caret === null ? set.mapPos(state.selection.main.head) : set.mapPos(caret, -1) + caretText;
  return {
    changes: set,
    selection: EditorSelection.cursor(Math.min(anchor, set.newLength)),
    annotations: tableEdit.of(true),
    userEvent: transaction.annotation(Transaction.userEvent),
    scrollIntoView: true
  };
}

/** Whether the selection is whole rows, from a row's start to another's: those go as rows, not cell by cell. */
function wholeRows(state: EditorState, table: TableModel) {
  const { from, to } = state.selection.main;
  const starts = table.rows.map(row => row.lineFrom);
  return (starts.includes(from) || from === table.rows[0].lineFrom) && (starts.includes(to) || to === table.to + 1 || to === table.to && from === table.rows[0].lineFrom);
}

/** Typing or deleting over a block of cells empties them; typed text goes in the anchor cell, as in a spreadsheet. */
function replaceCells(transaction: Transaction, range: CellRange): TransactionSpec {
  const state = transaction.startState;
  const start = range.table.rows[0].lineFrom;
  let inserted = "", outside = false;
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    if (fromA < start || toA > range.table.to) outside = true;
    inserted += text.toString();
  });
  // A change past the table, such as dropped text, is not an edit of these cells.
  if (outside) return transaction;
  const text = escapeCell(inserted);
  const anchor = range.table.rows[range.anchor.row].cells[range.anchor.column];
  const userEvent = transaction.annotation(Transaction.userEvent);
  // After deleting, the emptied block stays selected; after typing, the caret follows the text.
  if (!text || !anchor) return clearBlock(state, range, userEvent) ?? {};
  const set = state.changes([...clearCells(state, range), { from: anchor.contentFrom, insert: text }]);
  return {
    changes: set,
    selection: EditorSelection.cursor(set.mapPos(anchor.contentFrom, -1) + text.length),
    annotations: tableEdit.of(true),
    userEvent,
    scrollIntoView: true
  };
}

/** Steps a block of cells' head; from inside a single cell, only leaving it by an edge starts a block. */
function extendCells(view: EditorView, rows: number, columns: number): boolean {
  const range = cellRange(view.state);
  let table: TableModel, anchor, head;
  if (range) ({ table, anchor, head } = range);
  else {
    const context = tableContext(view.state);
    if (!context) return false;
    const cell = context.table.rows[context.at.row].cells[context.at.column];
    const position = view.state.selection.main.head;
    if (cell && ((columns > 0 && position < cell.contentTo) || (columns < 0 && position > cell.contentFrom))) return false;
    ({ table } = context);
    anchor = head = context.at;
  }
  const order = table.rows.flatMap((row, index) => row.kind === "delimiter" ? [] : [index]);
  const row = order[order.indexOf(head.row) + rows];
  const column = head.column + columns;
  if (row === undefined || column < 0 || column >= table.columns) return !!range;
  view.dispatch({ ...selectCells(table, anchor, { row, column }), scrollIntoView: true, userEvent: "select" });
  return true;
}

/** Select-all inside a table takes the table first, then the note. */
function selectTable(view: EditorView): boolean {
  const context = tableContext(view.state);
  if (!context) return false;
  const all = wholeTable(context.table);
  const block = selectCells(context.table, all.anchor, all.head);
  if (block.selection.eq(view.state.selection)) return false;
  view.dispatch({ ...block, userEvent: "select" });
  return true;
}

function copyCells(event: ClipboardEvent, view: EditorView): boolean {
  const range = cellRange(view.state);
  if (!range || !event.clipboardData) return false;
  const { markdown, html } = cellClipboard(view.state, range);
  event.preventDefault();
  event.clipboardData.setData("text/plain", markdown);
  event.clipboardData.setData("text/html", html);
  if (event.type === "cut" && !view.state.readOnly) {
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
  }
  return true;
}

/** Text in a pasted HTML cell, keeping its line breaks as `<br>`. */
function htmlCellText(cell: HTMLTableCellElement) {
  const breakMark = "\uE000";
  for (const element of cell.querySelectorAll("br")) element.replaceWith(breakMark);
  for (const element of cell.querySelectorAll("p, div, li")) element.append(breakMark);
  return escapeCell((cell.textContent ?? "").split(breakMark).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
}

/** A clipboard holding just one HTML table, as browsers, spreadsheets and documents copy them. */
function htmlGrid(html: string): string[][] | null {
  if (!/<table[\s>]/i.test(html)) return null;
  const document_ = new DOMParser().parseFromString(html, "text/html");
  // Spreadsheets put their styles in the clipboard's body.
  for (const element of document_.querySelectorAll("style, script, template")) element.remove();
  const tables = document_.querySelectorAll("table");
  const visible = (node: Node) => (node.textContent ?? "").replace(/\s+/g, "").length;
  if (tables.length !== 1 || visible(document_.body) > visible(tables[0])) return null;
  const grid = [...tables[0].rows].map(row => [...row.cells].map(htmlCellText)).filter(row => row.length);
  return grid.length ? grid : null;
}

/** A new Markdown table from a grid, on its own lines so nothing around it joins it. */
function insertTable(view: EditorView, grid: string[][]): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const width = Math.max(...grid.map(row => row.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  const table = [line(grid[0]), line(Array(width).fill("---")), ...grid.slice(1).map(line)].join("\n");
  const first = state.doc.lineAt(from), last = state.doc.lineAt(to);
  const textBefore = !!state.sliceDoc(first.from, from).trim(), textAfter = !!state.sliceDoc(to, last.to).trim();
  const lineBefore = first.number > 1 && !!state.doc.line(first.number - 1).text.trim();
  const lineAfter = last.number < state.doc.lines && !!state.doc.line(last.number + 1).text.trim();
  const before = textBefore ? "\n\n" : lineBefore ? "\n" : "";
  const after = textAfter ? "\n\n" : lineAfter ? "\n" : "";
  view.dispatch({ changes: { from, to, insert: before + table + after }, selection: { anchor: from + before.length + table.length }, scrollIntoView: true, userEvent: "input.paste" });
  return true;
}

/**
 * A caret at a cell's edge borders a hidden pipe, which has no box: measured on that side, the
 * caret sits at the top of the window and scrolling into view jumps there. Bind it to the cell's side.
 */
function caretSide(transaction: Transaction): TransactionSpec | readonly TransactionSpec[] {
  if (!transaction.selection && !transaction.docChanged) return transaction;
  const { state } = transaction;
  const { main } = state.selection;
  if (!main.empty || state.selection.ranges.length !== 1) return transaction;
  const table = tableAt(state, main.head);
  const at = table && main.head >= table.rows[0].lineFrom && main.head <= table.to ? cellAt(table, main.head) : null;
  const cell = at && table!.rows[at.row].cells[at.column];
  if (!cell) return transaction;
  // An empty cell's caret stop is the widget after it; text ends before the caret.
  const side = cell.contentFrom === cell.contentTo && main.head === cell.contentFrom ? 1 : main.head >= cell.contentTo ? -1 : main.head <= cell.contentFrom ? 1 : 0;
  if (!side || main.assoc === side) return transaction;
  return [transaction, { selection: EditorSelection.create([EditorSelection.cursor(main.head, side)]), sequential: true }];
}

function paste(event: ClipboardEvent, view: EditorView): boolean {
  if (view.state.readOnly || !event.clipboardData) return false;
  const text = event.clipboardData.getData("text/plain");
  const html = event.clipboardData.getData("text/html");
  const range = cellRange(view.state);
  const context = range ? null : tableContext(view.state);
  if (range || context) {
    const grid = parseGrid(text) ?? htmlGrid(html);
    // One value into one cell is plain typing; over a block, protectRows puts it in the anchor cell.
    if (!grid || (grid.length === 1 && grid[0].length < 2)) return false;
    event.preventDefault();
    const at = range ? { row: rangeCells(range).rows[0], column: rangeCells(range).columns[0] } : context!.at;
    return dispatchTableEdit(view, pasteGrid(view.state, range?.table ?? context!.table, at, grid), "input.paste.table");
  }
  // Outside a table, an HTML table becomes a Markdown table, unless the text already is one.
  if (parseGrid(text) && /^\s*\|/.test(text)) return false;
  const grid = htmlGrid(html);
  if (!grid) return false;
  event.preventDefault();
  return insertTable(view, grid);
}

/** Typing over a block of cells goes through protectRows, not the browser's edit of the text under it. */
function typeOverCells(event: InputEvent, view: EditorView): boolean {
  if (!cellRange(view.state) || view.state.readOnly) return false;
  const typing = event.inputType === "insertText" && event.data;
  const deleting = event.inputType.startsWith("delete");
  if (!typing && !deleting) return false;
  event.preventDefault();
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: typing ? event.data! : "" }, userEvent: typing ? "input.type" : "delete" });
  return true;
}

/** Empty cells hold no text to hit, so a click there places the caret explicitly. */
/** A press on a missing cell materializes it; the drag that follows is `cellDrag`'s. */
function clickCell(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0 || event.shiftKey || !(event.target instanceof Element) || view.state.readOnly) return false;
  const filler = event.target.closest<HTMLElement>("[data-lp-fill]");
  const target = filler && cellTarget(view, filler);
  const table = target && tableAt(view.state, target.tableFrom);
  if (table) cellSelection(view, table, target.at.row, target.at.column, false);
  return false;
}

/** The block a pointer drag last selected, so its transaction can carry the block's corners. */
let pointerBlock: ReturnType<typeof selectCells> | null = null;

/**
 * A drag from a cell selects by the cells under the pointer, so empty and missing cells, which
 * have no text to hit, can be a block's corners. Within one cell it selects that cell's text.
 */
function cellDrag(view: EditorView, start: MouseEvent): MouseSelectionStyle | null {
  if (start.button !== 0 || start.detail !== 1 || start.shiftKey || start.altKey || start.ctrlKey || start.metaKey) return null;
  let origin = cellTarget(view, start.target instanceof Element ? start.target : null);
  if (!origin) return null;
  const textAt = (table: TableModel, at: TablePosition, x: number, y: number) => {
    const cell = table.rows[at.row].cells[at.column];
    return cell ? Math.max(cell.contentFrom, Math.min(view.posAtCoords({ x, y }, false), cell.contentTo)) : table.rows[at.row].to;
  };
  let table = tableAt(view.state, origin.tableFrom)!;
  let anchor = textAt(table, origin.at, start.clientX, start.clientY);
  let last = origin.at;
  return {
    get(event) {
      pointerBlock = null;
      const { clientX: x, clientY: y } = event;
      const element = view.root.elementFromPoint(x, y);
      const here = cellTarget(view, element);
      if (here?.tableFrom === origin!.tableFrom) last = here.at;
      // Between cells, the block holds; past the table, the selection is text again.
      else if (here || !element?.closest(".cm-lp-table")) return EditorSelection.single(anchor, view.posAtCoords({ x, y }, false));
      if (last.row === origin!.at.row && last.column === origin!.at.column) return EditorSelection.single(anchor, textAt(table, last, x, y));
      pointerBlock = selectCells(table, origin!.at, last);
      return pointerBlock.selection;
    },
    update(update) {
      if (!update.docChanged) return false;
      anchor = update.changes.mapPos(anchor);
      origin = { ...origin!, tableFrom: update.changes.mapPos(origin!.tableFrom) };
      const next = tableAt(update.state, origin.tableFrom);
      if (next) table = next;
      return false;
    }
  };
}

/** Tables edit in place: the Markdown rows are laid out as the grid, so the caret, undo, IME and search are the editor's own. */
/**
 * At a cell's end the view puts the DOM caret after the cell, among the hidden pipe
 * spans, and the browser then types into the next visible cell. Keep it in the text.
 */
function keepCaretInCell(update: ViewUpdate) {
  const { view } = update;
  if (!(update.selectionSet || update.docChanged) || !view.hasFocus) return;
  const selection = (view.root as Document).getSelection?.();
  const line = selection?.isCollapsed ? selection.anchorNode : null;
  if (!(line instanceof HTMLElement) || !line.classList.contains("cm-lp-tr")) return;
  let cell: Node | null = line.childNodes[selection!.anchorOffset - 1] ?? null;
  while (cell && !(cell instanceof HTMLElement && cell.classList.contains("cm-lp-td"))) {
    if (cell instanceof HTMLElement && cell.offsetParent !== null) return;
    cell = cell.previousSibling;
  }
  if (!cell || view.posAtDOM(cell, cell.childNodes.length) !== view.state.selection.main.head) return;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let text: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) text = node;
  if (text) selection!.collapse(text, text.textContent!.length);
}

export function tablePreview(): Extension {
  return [
    tableView,
    EditorView.updateListener.of(keepCaretInCell),
    EditorState.transactionFilter.of(protectRows),
    EditorState.transactionFilter.of(caretSide),
    cellCorners,
    EditorState.transactionExtender.of(transaction => pointerBlock && transaction.isUserEvent("select.pointer") && transaction.selection?.eq(pointerBlock.selection)
      ? { effects: pointerBlock.effects } : null),
    EditorView.mouseSelectionStyle.of(cellDrag),
    Prec.highest(keymap.of([
      { key: "Tab", run: view => nextCell(view, 1) },
      { key: "Shift-Tab", run: view => nextCell(view, -1) },
      { key: "Enter", run: enter },
      { key: "Mod-Enter", run: insertBelow },
      { key: "Shift-Enter", run: view => tableContext(view.state) ? dispatchTableEdit(view, { changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: "<br>" }, anchor: view.state.selection.main.from + 4 }) : false },
      { key: "Backspace", run: backspaceRow },
      { key: "Home", run: view => cellBoundary(view, -1, false), shift: view => cellBoundary(view, -1, true) },
      { key: "End", run: view => cellBoundary(view, 1, false), shift: view => cellBoundary(view, 1, true) },
      { key: "Alt-ArrowUp", run: view => shiftRow(view, -1) },
      { key: "Alt-ArrowDown", run: view => shiftRow(view, 1) },
      { key: "Shift-ArrowLeft", run: view => extendCells(view, 0, -1) },
      { key: "Shift-ArrowRight", run: view => extendCells(view, 0, 1) },
      { key: "Shift-ArrowUp", run: view => extendCells(view, -1, 0) },
      { key: "Shift-ArrowDown", run: view => extendCells(view, 1, 0) },
      { key: "Mod-a", run: selectTable }
    ])),
    EditorView.domEventHandlers({ paste, copy: copyCells, cut: copyCells, beforeinput: typeOverCells, mousedown: clickCell }),
    tableControls()
  ];
}
