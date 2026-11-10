import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { t } from "@lingui/core/macro";
import {
  alignColumn, cellClipboard, cellRange, clearBlock, deleteColumns, deleteRows, dispatchTableEdit, insertColumn, insertRow, moveColumn, moveRow, rangeCells, sortRows,
  tableAt, tableContext, wholeTable, type CellRange, type TableAlignment, type TableEdit, type TableModel, type TablePosition
} from "./table-model.js";

const SVG = "http://www.w3.org/2000/svg";

function icon(kind: "grip-x" | "grip-y" | "plus"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const dots = kind === "grip-x" ? [[4, 6], [8, 6], [12, 6], [4, 10], [8, 10], [12, 10]] : [[6, 4], [10, 4], [6, 8], [10, 8], [6, 12], [10, 12]];
  if (kind === "plus") {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", "M8 3.5v9M3.5 8h9");
    svg.append(path);
  } else for (const [cx, cy] of dots) {
    const dot = document.createElementNS(SVG, "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", "1.15");
    svg.append(dot);
  }
  return svg;
}

interface Target { tableFrom: number; at: TablePosition }

/** The table cell an element is in, read from the layout: empty and missing cells have no text to hit. */
export function cellTarget(view: EditorView, element: Element | null): Target | null {
  const cell = element?.closest<HTMLElement>(".cm-lp-td");
  const line = cell?.closest<HTMLElement>(".cm-line");
  if (!cell || !line || !view.contentDOM.contains(line)) return null;
  const position = view.posAtDOM(line, 0);
  const table = tableAt(view.state, position);
  if (!table) return null;
  const row = table.rows.findIndex(row => row.lineFrom === position);
  const column = [...line.querySelectorAll(":scope > .cm-lp-td")].indexOf(cell);
  return row < 0 || column < 0 ? null : { tableFrom: table.from, at: { row, column } };
}

type Item = { label: string; run: (table: TableModel, at: TablePosition) => TableEdit | null; checked?: boolean; danger?: boolean; disabled?: boolean } | "separator";

/** Puts cells on the clipboard: Markdown for text, an HTML table for spreadsheets and documents. */
function writeCells(view: EditorView, range: CellRange) {
  const { markdown, html } = cellClipboard(view.state, range);
  void navigator.clipboard.write([new ClipboardItem({
    "text/plain": new Blob([markdown], { type: "text/plain" }),
    "text/html": new Blob([html], { type: "text/html" })
  })]);
}

const copyTable = (view: EditorView): Item => ({
  label: t({ message: "Copy table", context: "table" }),
  run: table => { writeCells(view, wholeTable(table)); return null; }
});

/** The selected block's own actions, as its keyboard shortcuts do them. */
function blockItems(view: EditorView): Item[] {
  const act = (copy: boolean, clear: boolean) => () => {
    const range = cellRange(view.state);
    if (!range) return null;
    if (copy) writeCells(view, range);
    const edit = clear ? clearBlock(view.state, range, copy ? "delete.cut" : "delete") : null;
    if (edit) view.dispatch(edit);
    return null;
  };
  return [
    { label: t({ message: "Copy cells", context: "table" }), run: act(true, false) },
    { label: t({ message: "Cut cells", context: "table" }), run: act(true, true) },
    { label: t({ message: "Clear cells", context: "table" }), run: act(false, true) }
  ];
}

function rowMoves(view: EditorView, table: TableModel, at: TablePosition): Item[] {
  if (table.rows[at.row].kind !== "body") return [{ label: t({ message: "Insert row below", context: "table" }), run: (table, at) => insertRow(table, at.row) }];
  return [
    { label: t({ message: "Insert row above", context: "table" }), run: (table, at) => insertRow(table, at.row - 1) },
    { label: t({ message: "Insert row below", context: "table" }), run: (table, at) => insertRow(table, at.row) },
    { label: t({ message: "Move row up", context: "table" }), run: (table, at) => moveRowAt(view, table, at, at.row - 1), disabled: table.rows[at.row - 1]?.kind !== "body" },
    { label: t({ message: "Move row down", context: "table" }), run: (table, at) => moveRowAt(view, table, at, at.row + 1), disabled: table.rows[at.row + 1]?.kind !== "body" }
  ];
}

function deleteRowsItem(table: TableModel, rows: number[]): Item[] {
  const body = rows.filter(row => table.rows[row].kind === "body");
  if (!body.length) return [];
  const label = body.length > 1 ? t({ message: "Delete rows", context: "table" }) : t({ message: "Delete row", context: "table" });
  return [{ label, run: table => deleteRows(table, body), danger: true }];
}

function moveRowAt(view: EditorView, table: TableModel, at: TablePosition, target: number) {
  const cell = table.rows[at.row].cells[at.column];
  // The caret stays on its row, so put it in the row being moved.
  const state = view.state.update({ selection: { anchor: cell?.contentTo ?? table.rows[at.row].to } }).state;
  return moveRow(state, table, at.row, target);
}

function columnMoves(view: EditorView, table: TableModel, at: TablePosition): Item[] {
  return [
    { label: t({ message: "Insert column left", context: "table" }), run: (table, at) => insertColumn(view.state, table, at, at.column) },
    { label: t({ message: "Insert column right", context: "table" }), run: (table, at) => insertColumn(view.state, table, at, at.column + 1) },
    { label: t({ message: "Move column left", context: "table" }), run: (table, at) => moveColumn(view.state, table, at, at.column - 1), disabled: at.column === 0 },
    { label: t({ message: "Move column right", context: "table" }), run: (table, at) => moveColumn(view.state, table, at, at.column + 1), disabled: at.column >= table.columns - 1 }
  ];
}

function columnFormat(view: EditorView, table: TableModel, at: TablePosition): Item[] {
  const align = (alignment: TableAlignment, label: string): Item => ({
    label, checked: (table.alignments[at.column] ?? "left") === alignment, run: (table, at) => alignColumn(view.state, table, at, alignment)
  });
  return [
    align("left", t({ message: "Align left", context: "table" })),
    align("center", t({ message: "Align center", context: "table" })),
    align("right", t({ message: "Align right", context: "table" })),
    "separator",
    { label: t({ message: "Sort ascending", context: "table" }), run: (table, at) => sortRows(view.state, table, at.column, 1), disabled: table.rows.length < 4 },
    { label: t({ message: "Sort descending", context: "table" }), run: (table, at) => sortRows(view.state, table, at.column, -1), disabled: table.rows.length < 4 }
  ];
}

function deleteColumnsItem(view: EditorView, table: TableModel, columns: number[]): Item {
  const label = columns.length > 1 ? t({ message: "Delete columns", context: "table" }) : t({ message: "Delete column", context: "table" });
  return { label, run: (table, at) => deleteColumns(view.state, table, at, columns), danger: true, disabled: columns.length >= table.columns };
}

function menuItems(view: EditorView, kind: "row" | "column" | "cell", table: TableModel, at: TablePosition): Item[] {
  const end = (deletes: Item[]): Item[] => ["separator", copyTable(view), ...(deletes.length ? ["separator" as const, ...deletes] : [])];
  if (kind === "row") return [...rowMoves(view, table, at), ...end(deleteRowsItem(table, [at.row]))];
  if (kind === "column") return [...columnMoves(view, table, at), "separator", ...columnFormat(view, table, at), ...end([deleteColumnsItem(view, table, [at.column])])];
  // Inside a selected block, the block's actions lead and deleting takes all its rows or columns.
  const range = cellRange(view.state);
  const block = range && range.table.from === table.from ? rangeCells(range) : null;
  const inBlock = !!block && block.rows.includes(at.row) && block.columns.includes(at.column);
  return [
    ...(inBlock ? [...blockItems(view), "separator" as const] : []),
    ...rowMoves(view, table, at), "separator",
    ...columnMoves(view, table, at), "separator",
    ...columnFormat(view, table, at),
    ...end([...deleteRowsItem(table, inBlock ? block.rows : [at.row]), deleteColumnsItem(view, table, inBlock ? block.columns : [at.column])])
  ];
}

/** One open menu per editor. Built from plain buttons so it reads as a menu to assistive tech. */
class Menu {
  readonly dom: HTMLElement;
  private readonly close: (event: Event) => void;
  constructor(readonly view: EditorView, readonly target: Target, items: Item[], x: number, y: number, readonly onClose: () => void) {
    const menu = this.dom = document.createElement("div");
    menu.className = "mdbase-menu cm-lp-table-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", t({ message: "Table options", context: "table" }));
    for (const item of items) {
      if (item === "separator") {
        const rule = document.createElement("div");
        rule.className = "cm-lp-table-menu-separator";
        rule.setAttribute("role", "separator");
        menu.append(rule);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mdbase-menu-item";
      button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
      if (item.checked !== undefined) button.setAttribute("aria-checked", String(item.checked));
      if (item.danger) button.classList.add("is-danger");
      button.disabled = item.disabled ?? false;
      button.textContent = item.label;
      button.addEventListener("click", () => this.run(item.run));
      menu.append(button);
    }
    menu.addEventListener("keydown", event => this.key(event));
    const document_ = view.dom.ownerDocument;
    document_.body.append(menu);
    // Keep the menu on screen, flipping above its anchor when needed.
    const rect = menu.getBoundingClientRect();
    const viewport = document_.documentElement;
    menu.style.left = `${Math.max(8, Math.min(x, viewport.clientWidth - rect.width - 8))}px`;
    menu.style.top = `${y + rect.height > viewport.clientHeight - 8 ? Math.max(8, y - rect.height - 8) : y}px`;
    this.close = event => {
      if (event.type === "keydown" || !(event.target instanceof Node && menu.contains(event.target))) this.destroy(event.type === "keydown");
    };
    document_.addEventListener("pointerdown", this.close, true);
    document_.addEventListener("scroll", this.close, true);
    window.addEventListener("resize", this.close);
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }
  private buttons() { return [...this.dom.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; }
  private key(event: KeyboardEvent) {
    const buttons = this.buttons();
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const move = (to: number) => { event.preventDefault(); buttons[(to + buttons.length) % buttons.length]?.focus(); };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); this.destroy(true); }
  }
  private run(run: (table: TableModel, at: TablePosition) => TableEdit | null) {
    const table = tableAt(this.view.state, this.target.tableFrom);
    this.destroy(true);
    if (table) dispatchTableEdit(this.view, run(table, this.target.at));
  }
  destroy(refocus: boolean) {
    const document_ = this.view.dom.ownerDocument;
    document_.removeEventListener("pointerdown", this.close, true);
    document_.removeEventListener("scroll", this.close, true);
    window.removeEventListener("resize", this.close);
    this.dom.remove();
    this.onClose();
    if (refocus) this.view.focus();
  }
}

interface Layout {
  table: DOMRect;
  column: DOMRect;
  row: DOMRect;
  scroller: DOMRect;
  scroll: { top: number; left: number };
}

interface Drag {
  kind: "row" | "column";
  target: Target;
  x: number;
  y: number;
  /** The row or column index it would land on; null until the pointer has moved. */
  to: number | null;
}

/** Row and column grips plus add buttons, drawn over the editor rather than inside the document. */
class Controls {
  readonly layer: HTMLElement;
  readonly column: HTMLButtonElement;
  readonly row: HTMLButtonElement;
  readonly addRow: HTMLButtonElement;
  readonly addColumn: HTMLButtonElement;
  readonly source: HTMLElement;
  readonly drop: HTMLElement;
  hover: Target | null = null;
  target: Target | null = null;
  menu: Menu | null = null;
  drag: Drag | null = null;
  /** A drag ends with a click on its grip, which must not open the menu. */
  dragged = false;
  constructor(readonly view: EditorView) {
    this.layer = document.createElement("div");
    this.layer.className = "cm-lp-table-controls";
    this.layer.setAttribute("aria-hidden", "true");
    const button = (className: string, kind: Parameters<typeof icon>[0], label: string, click: (event: MouseEvent) => void) => {
      const element = document.createElement("button");
      element.type = "button";
      element.tabIndex = -1;
      element.className = className;
      element.title = label;
      element.append(icon(kind));
      // Keep the caret and focus in the editor.
      element.addEventListener("mousedown", event => event.preventDefault());
      element.addEventListener("click", click);
      this.layer.append(element);
      return element;
    };
    this.column = button("cm-lp-table-grip cm-lp-table-grip-column", "grip-x", t({ message: "Column options", context: "table" }), event => this.dragged || this.open("column", event));
    this.row = button("cm-lp-table-grip cm-lp-table-grip-row", "grip-y", t({ message: "Row options", context: "table" }), event => this.dragged || this.open("row", event));
    this.addRow = button("cm-lp-table-add cm-lp-table-add-row", "plus", t({ message: "Add row", context: "table" }), () => this.add("row"));
    this.addColumn = button("cm-lp-table-add cm-lp-table-add-column", "plus", t({ message: "Add column", context: "table" }), () => this.add("column"));
    this.source = document.createElement("div");
    this.source.className = "cm-lp-table-drag-source";
    this.drop = document.createElement("div");
    this.drop.className = "cm-lp-table-drop";
    this.source.hidden = this.drop.hidden = true;
    this.layer.append(this.source, this.drop);
    this.column.addEventListener("pointerdown", event => this.startDrag("column", event));
    this.row.addEventListener("pointerdown", event => this.startDrag("row", event));
    view.scrollDOM.append(this.layer);
    this.schedule();
  }
  current(): Target | null {
    if (this.menu) return this.menu.target;
    if (this.hover) return this.hover;
    if (!this.view.hasFocus) return null;
    const context = tableContext(this.view.state);
    return context ? { tableFrom: context.table.from, at: context.at } : null;
  }
  update(update: ViewUpdate) {
    if (update.docChanged && this.hover) this.hover = null;
    if (update.docChanged || update.selectionSet || update.focusChanged || update.geometryChanged || update.viewportChanged) this.schedule();
  }
  schedule() {
    this.view.requestMeasure({ key: this, read: view => this.read(view), write: layout => this.write(layout) });
  }
  private cellElements(target: Target) {
    const table = tableAt(this.view.state, target.tableFrom);
    if (!table || target.at.row >= table.rows.length) return null;
    const line = (row: number) => {
      const { node } = this.view.domAtPos(table.rows[row].lineFrom);
      return (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".cm-line") ?? null;
    };
    const row = line(target.at.row), header = line(0);
    const column = header?.querySelectorAll<HTMLElement>(":scope > .cm-lp-td")[target.at.column];
    const wrapper = header?.closest<HTMLElement>(".cm-lp-table");
    return row && column && wrapper ? { row, column, wrapper } : null;
  }
  private read(view: EditorView): Layout | null {
    this.target = this.current();
    if (!this.target || view.state.readOnly) return null;
    const elements = this.cellElements(this.target);
    if (!elements) return null;
    return {
      table: elements.wrapper.getBoundingClientRect(),
      column: elements.column.getBoundingClientRect(),
      row: elements.row.getBoundingClientRect(),
      scroller: view.scrollDOM.getBoundingClientRect(),
      scroll: { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }
    };
  }
  private write(layout: Layout | null) {
    this.layer.classList.toggle("cm-lp-table-controls-visible", layout !== null);
    if (!layout) return;
    const x = (value: number) => `${value - layout.scroller.left + layout.scroll.left}px`;
    const y = (value: number) => `${value - layout.scroller.top + layout.scroll.top}px`;
    const place = (element: HTMLElement, left: string, top: string, width?: string, height?: string) => {
      element.style.left = left;
      element.style.top = top;
      element.style.width = width ?? "";
      element.style.height = height ?? "";
    };
    place(this.column, x(layout.column.left + layout.column.width / 2), y(layout.table.top));
    place(this.row, x(layout.table.left), y(layout.row.top + layout.row.height / 2));
    place(this.addRow, x(layout.table.left), y(layout.table.bottom), `${layout.table.width}px`);
    place(this.addColumn, x(layout.table.right), y(layout.table.top), undefined, `${layout.table.height}px`);
  }
  private open(kind: "row" | "column" | "both", event: MouseEvent | null, at?: { x: number; y: number }) {
    const target = this.current();
    this.menu?.destroy(false);
    if (!target) return;
    const table = tableAt(this.view.state, target.tableFrom);
    if (!table) return;
    const items = menuItems(this.view, kind === "both" ? "cell" : kind, table, target.at);
    const anchor = event?.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
    const x = at?.x ?? (anchor ? anchor.left : 0), y = at?.y ?? (anchor ? anchor.bottom + 4 : 0);
    this.menu = new Menu(this.view, target, items, x, y, () => { this.menu = null; this.schedule(); });
  }
  /** Opens both sections at a point, for right-click, long-press and the keyboard. */
  openAt(target: Target, x: number, y: number) {
    this.hover = target;
    this.open("both", null, { x, y });
  }
  private add(kind: "row" | "column") {
    const target = this.current();
    const table = target && tableAt(this.view.state, target.tableFrom);
    if (!target || !table) return;
    this.hover = null;
    if (kind === "row") dispatchTableEdit(this.view, insertRow(table, table.rows.length - 1));
    // A new column starts at its header, which is the first thing it needs.
    else dispatchTableEdit(this.view, insertColumn(this.view.state, table, { row: 0, column: table.columns - 1 }, table.columns));
    this.view.focus();
  }
  /** Rows and columns move by dragging their grip; a press without movement stays a click. */
  private startDrag(kind: "row" | "column", event: PointerEvent) {
    this.dragged = false;
    const target = this.current();
    if (event.button !== 0 || !target || this.view.state.readOnly) return;
    const grip = event.currentTarget as HTMLElement;
    grip.setPointerCapture(event.pointerId);
    this.drag = { kind, target, x: event.clientX, y: event.clientY, to: null };
    const move = (moved: PointerEvent) => this.moveDrag(moved);
    const end = (ended: PointerEvent | KeyboardEvent) => {
      if (ended instanceof KeyboardEvent) {
        if (ended.key !== "Escape") return;
        // Escape drops the drag wherever focus is.
        ended.preventDefault();
        ended.stopPropagation();
      }
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", end, true);
      this.endDrag(ended.type === "pointerup");
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    window.addEventListener("keydown", end, true);
  }
  private moveDrag(event: PointerEvent) {
    const drag = this.drag;
    const table = drag && tableAt(this.view.state, drag.target.tableFrom);
    if (!drag || !table) return;
    if (drag.to === null && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    const slots = this.slots(table, drag.kind);
    const wrapper = slots[0]?.element.closest<HTMLElement>(".cm-lp-table");
    if (!wrapper) return;
    const row = drag.kind === "row";
    const point = row ? event.clientY : event.clientX;
    const from = row ? drag.target.at.row : drag.target.at.column;
    const slot = slots.find(slot => point < (row ? slot.rect.bottom : slot.rect.right)) ?? slots.at(-1)!;
    const source = slots.find(slot => slot.index === from);
    drag.to = slot.index;
    this.layer.classList.add("cm-lp-table-dragging");
    const scroller = this.view.scrollDOM.getBoundingClientRect();
    const frame = wrapper.getBoundingClientRect();
    const place = (element: HTMLElement, left: number, top: number, width: number, height: number) => {
      element.hidden = false;
      element.style.left = `${left - scroller.left + this.view.scrollDOM.scrollLeft}px`;
      element.style.top = `${top - scroller.top + this.view.scrollDOM.scrollTop}px`;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    };
    if (source) {
      if (row) place(this.source, frame.left, source.rect.top, frame.width, source.rect.height);
      else place(this.source, source.rect.left, frame.top, source.rect.width, frame.height);
    }
    // The line marks the edge the moved row or column will land against.
    if (slot.index === from) this.drop.hidden = true;
    else if (row) place(this.drop, frame.left, slot.index > from ? slot.rect.bottom : slot.rect.top, frame.width, 0);
    else place(this.drop, slot.index > from ? slot.rect.right : slot.rect.left, frame.top, 0, frame.height);
  }
  private endDrag(commit: boolean) {
    const drag = this.drag;
    this.drag = null;
    this.layer.classList.remove("cm-lp-table-dragging");
    this.source.hidden = this.drop.hidden = true;
    if (!drag || drag.to === null) return;
    this.dragged = true;
    const table = tableAt(this.view.state, drag.target.tableFrom);
    if (!commit || !table) return;
    const { at } = drag.target;
    const edit = drag.kind === "row" ? moveRowAt(this.view, table, at, drag.to) : moveColumn(this.view.state, table, at, drag.to);
    this.hover = null;
    if (edit) dispatchTableEdit(this.view, edit, "move.table");
    this.view.focus();
  }
  /** The rows or columns a drag can land on, by their rendered rectangles. */
  private slots(table: TableModel, kind: "row" | "column") {
    const line = (row: number) => {
      const { node } = this.view.domAtPos(table.rows[row].lineFrom);
      return (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".cm-line") ?? null;
    };
    const slots: Array<{ index: number; element: HTMLElement; rect: DOMRect }> = [];
    if (kind === "row") {
      table.rows.forEach((row, index) => {
        const element = row.kind === "body" ? line(index) : null;
        if (element) slots.push({ index, element, rect: element.getBoundingClientRect() });
      });
    } else {
      line(0)?.querySelectorAll<HTMLElement>(":scope > .cm-lp-td").forEach((element, index) => slots.push({ index, element, rect: element.getBoundingClientRect() }));
    }
    return slots;
  }
  pointer(event: MouseEvent) {
    if (this.menu || this.drag) return;
    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest(".cm-lp-table-controls")) return;
    const next = this.targetAt(element);
    if (next?.tableFrom === this.hover?.tableFrom && next?.at.row === this.hover?.at.row && next?.at.column === this.hover?.at.column) return;
    this.hover = next;
    this.schedule();
  }
  targetAt(element: Element | null): Target | null {
    return cellTarget(this.view, element);
  }
  destroy() {
    this.menu?.destroy(false);
    this.layer.remove();
  }
}

const controls = ViewPlugin.fromClass(Controls, {
  eventHandlers: {
    mousemove(event) { this.pointer(event); },
    mouseleave() { if (this.hover && !this.menu) { this.hover = null; this.schedule(); } },
    contextmenu(event, view) {
      const target = this.targetAt(event.target instanceof Element ? event.target : null);
      if (!target || view.state.readOnly) return false;
      event.preventDefault();
      this.openAt(target, event.clientX, event.clientY);
      return true;
    },
    keydown(event, view) {
      if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return false;
      const context = tableContext(view.state);
      if (!context || view.state.readOnly) return false;
      const coords = view.coordsAtPos(view.state.selection.main.head);
      event.preventDefault();
      this.openAt({ tableFrom: context.table.from, at: context.at }, coords?.left ?? 0, coords?.bottom ?? 0);
      return true;
    }
  }
});

export function tableControls() {
  return controls;
}
