import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { expect, it } from "vitest";
import { revealTracking } from "./reveal.js";
import { tablePreview } from "./table.js";
import { alignColumn, cellClipboard, cellRange, deleteColumns, deleteRows, insertColumn, moveColumn, moveRow, parseGrid, pasteGrid, rangeCells, sortRows, tableAt, type TableEdit } from "./table-model.js";

/** `¦` marks the caret; a second `¦` makes the first the anchor and the second the head. */
function editor(source: string) {
  const anchor = source.indexOf("¦");
  const head = source.indexOf("¦", anchor + 1);
  let state = EditorState.create({
    doc: source.replaceAll("¦", ""),
    selection: { anchor: Math.max(anchor, 0), head: head < 0 ? Math.max(anchor, 0) : head - 1 },
    extensions: [markdown({ base: markdownLanguage }), revealTracking(), tablePreview()]
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = {
    get state() { return state; },
    dispatch(spec: Parameters<EditorState["update"]>[0]) { state = state.update(spec).state; ensureSyntaxTree(state, state.doc.length, 5000); },
    focus() {}
  } as unknown as EditorView;
  return {
    get state() { return state; },
    get table() { return tableAt(state, state.selection.main.head)!; },
    get doc() {
      const { from, to } = state.selection.main;
      return from === to ? state.sliceDoc(0, from) + "¦" + state.sliceDoc(from) : state.sliceDoc(0, from) + "¦" + state.sliceDoc(from, to) + "¦" + state.sliceDoc(to);
    },
    get cells() { const range = cellRange(state); return range && rangeCells(range); },
    key(key: string) { return state.facet(keymap).flat().find(binding => binding.key === key)!.run!(view); },
    type(insert: string, from = state.selection.main.from, to = state.selection.main.to) {
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: insert ? "input.type" : "delete" });
    },
    apply(edit: TableEdit | null) { if (edit) view.dispatch({ changes: edit.changes, selection: { anchor: edit.anchor } }); }
  };
}

it("escapes a typed pipe so it stays inside its cell", () => {
  const view = editor("| A | B |\n| --- | --- |\n| a¦ | b |");
  view.type("|");
  expect(view.doc).toBe("| A | B |\n| --- | --- |\n| a\\|¦ | b |");
  expect(view.table.columns).toBe(2);
});

it("deletes only cell text across cells, so no row loses a column", () => {
  const source = "| A | B |\n| --- | --- |\n| one | two |\n";
  const view = editor(source);
  view.type("", source.indexOf("ne"), source.indexOf("wo"));
  expect(view.state.doc.toString()).toBe("| A | B |\n| --- | --- |\n| o | wo |\n");
});

it("moves down with Enter, adds a row at the end, and exits on an empty last row", () => {
  const view = editor("| A | B |\n| --- | --- |\n| a | b¦ |\n");
  view.key("Enter");
  expect(view.doc).toBe("| A | B |\n| --- | --- |\n| a | b |\n|  | ¦ |\n");
  view.key("Enter");
  expect(view.doc).toBe("| A | B |\n| --- | --- |\n| a | b |\n\n¦\n");
});

it("adds rows with the table's quote prefix", () => {
  const view = editor("> | A |\n> | --- |\n> | a¦ |");
  view.key("Tab");
  expect(view.doc).toBe("> | A |\n> | --- |\n> | a |\n> | ¦ |");
});

it("sorts blank cells last and keeps the caret on its row", () => {
  const view = editor("| N |\n| --- |\n| pear |\n|  |\n| app¦le |\n| fig 10 |\n| fig 9 |");
  view.apply(sortRows(view.state, view.table, 0, 1));
  expect(view.doc).toBe("| N |\n| --- |\n| app¦le |\n| fig 9 |\n| fig 10 |\n| pear |\n|  |");
});

it("aligns a column without moving the caret", () => {
  const view = editor("| A | B |\n| --- | --- |\n| a | b¦c |");
  view.apply(alignColumn(view.state, view.table, { row: 2, column: 1 }, "center"));
  expect(view.doc).toBe("| A | B |\n| --- | :---: |\n| a | b¦c |");
});

it("inserts a column in every row, short rows included", () => {
  const view = editor("| A | B |\n| --- | --- |\n| a¦ |");
  view.apply(insertColumn(view.state, view.table, { row: 2, column: 0 }, 1));
  expect(view.doc).toBe("| A |  | B |\n| --- | --- | --- |\n| a | ¦ |");
});

it("pastes a spreadsheet grid, growing the table to fit", () => {
  const view = editor("| A | B |\n| --- | --- |\n| ¦ |  |");
  const grid = parseGrid("1\t2\t3\n4\t5\t6")!;
  view.apply(pasteGrid(view.state, view.table, { row: 2, column: 0 }, grid));
  expect(view.doc).toBe("| A | B |  |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6¦ |");
});

it("drags a row past several others, and the caret stays on its row", () => {
  const view = editor("| N |\n| --- |\n| a |\n| b¦ |\n| c |\n| d |");
  view.apply(moveRow(view.state, view.table, 2, 5));
  expect(view.doc).toBe("| N |\n| --- |\n| b¦ |\n| c |\n| d |\n| a |");
});

it("drags a column to another index in every row", () => {
  const view = editor("| A | B | C |\n| --- | :---: | --- |\n| a¦ | b | c |");
  view.apply(moveColumn(view.state, view.table, { row: 2, column: 0 }, 2));
  expect(view.doc).toBe("| B | C | A |\n| :---: | --- | --- |\n| b | c | a¦ |");
});

const grid = "| A | B | C |\n| --- | ---: | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n| a3 | b3 | c3 |";

it("treats a selection from one cell into another as the block of cells between them", () => {
  const view = editor(grid.replace("b1", "b¦1").replace("c2", "c¦2"));
  expect(view.cells).toEqual({ rows: [2, 3], columns: [1, 2] });
  expect(editor(grid.replace("b1", "¦b1¦")).cells).toBeNull();
});

it("extends a block cell by cell with Shift and the arrows, leaving a cell only from its edge", () => {
  const view = editor(grid.replace("b1", "b¦1"));
  expect(view.key("Shift-ArrowRight")).toBe(false);
  const edge = editor(grid.replace("b1", "b1¦"));
  edge.key("Shift-ArrowRight");
  expect(edge.cells).toEqual({ rows: [2], columns: [1, 2] });
  edge.key("Shift-ArrowDown");
  edge.key("Shift-ArrowDown");
  expect(edge.cells).toEqual({ rows: [2, 3, 4], columns: [1, 2] });
  edge.key("Shift-ArrowUp");
  edge.key("Shift-ArrowUp");
  edge.key("Shift-ArrowUp");
  expect(edge.cells).toEqual({ rows: [0, 2], columns: [1, 2] });
});

it("empties a block on delete and keeps it selected; typing starts in the anchor cell", () => {
  const view = editor(grid.replace("b1", "¦b1").replace("c2", "c2¦"));
  view.type("");
  expect(view.state.doc.toString()).toBe(grid.replace("b1", "").replace("c1", "").replace("b2", "").replace("c2", ""));
  expect(view.cells).toEqual({ rows: [2, 3], columns: [1, 2] });
  view.type("x|");
  expect(view.doc).toBe(grid.replace("b1", "x\\|¦").replace("c1", "").replace("b2", "").replace("c2", ""));
});

it("copies a block as Markdown and as an HTML table, with the header making a whole table", () => {
  const view = editor(grid.replace("| B", "| ¦B").replace("c1", "**c1** & [[Note\\|n]]¦").replace("b1", "b\\|1<br>`<x>`"));
  expect(cellClipboard(view.state, cellRange(view.state)!)).toEqual({
    markdown: "| B | C |\n| ---: | --- |\n| b\\|1<br>`<x>` | **c1** & [[Note\\|n]] |",
    html: "<table><thead><tr><th>B</th><th>C</th></tr></thead><tbody><tr><td>b|1<br><code>&lt;x&gt;</code></td><td><strong>c1</strong> &amp; n</td></tr></tbody></table>"
  });
  const rows = parseGrid("| b1 | c1 |")!;
  expect(rows).toEqual([["b1", "c1"]]);
});

it("selects the table, then the note, with select-all", () => {
  const view = editor(`Intro\n\n${grid.replace("b2", "b¦2")}`);
  view.key("Mod-a");
  expect(view.cells).toEqual({ rows: [0, 2, 3, 4], columns: [0, 1, 2] });
  expect(view.key("Mod-a")).toBe(false);
});

it("opens a line above the table with Enter at its very start", () => {
  const view = editor("| ¦A | B |\n| --- | --- |\n| a | b |");
  view.key("Enter");
  expect(view.doc).toBe("¦\n| A | B |\n| --- | --- |\n| a | b |");
  const quoted = editor("> | ¦A |\n> | --- |");
  quoted.key("Enter");
  expect(quoted.doc).toBe(">¦\n> | A |\n> | --- |");
  const inside = editor("| A¦ | B |\n| --- | --- |\n| a | b |");
  inside.key("Enter");
  expect(inside.doc).toBe("| A | B |\n| --- | --- |\n| a¦ | b |");
});

it("binds a caret at a cell's edges to the cell, not to the hidden pipe beside it", () => {
  const view = editor("| A | B |\n| --- | --- |\n| a¦ |  |");
  view.type("b");
  expect(view.state.selection.main.assoc).toBe(-1);
  view.type(" ");
  expect(view.state.selection.main.assoc).toBe(-1);
  view.key("Tab");
  expect(view.state.selection.main.assoc).toBe(1);
});

it("ends a block in a row's missing cells, which have no text to select", () => {
  const view = editor("| A | B | C |\n| --- | --- | --- |\n| a¦1 |\n| a2 | b2 |\n");
  view.key("Shift-ArrowDown");
  view.key("Shift-ArrowRight");
  view.key("Shift-ArrowRight");
  expect(view.cells).toEqual({ rows: [2, 3], columns: [0, 1, 2] });
  view.type("");
  expect(view.state.doc.toString()).toBe("| A | B | C |\n| --- | --- | --- |\n|  |\n|  |  |\n");
  expect(view.cells).toEqual({ rows: [2, 3], columns: [0, 1, 2] });
});

it("deletes several rows or columns at once, keeping the header and one column", () => {
  const view = editor(`${grid.replace("a1", "a¦1")}`);
  view.apply(deleteRows(view.table, [3, 2]));
  expect(view.doc).toBe(grid.replace(/\| a1 .*\n\| a2 .*\n/, "").replace("a3", "a3¦"));
  view.apply(deleteColumns(view.state, view.table, { row: 0, column: 0 }, [0, 1]));
  expect(view.state.doc.toString().split("\n")[0]).toBe("| C |");
  expect(deleteColumns(view.state, view.table, { row: 0, column: 0 }, [0])).toBeNull();
});
