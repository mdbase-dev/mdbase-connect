import { syntaxTree } from "@codemirror/language";
import type { Transaction } from "@codemirror/state";

/** Text blocks: an edit inside one changes inline content only. */
const proseBlocks = new Set([
  "Paragraph", "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6"
]);
/** Characters that open or close code, quotes and callouts, tables, formulas and footnotes. */
const structural = /[`~>|$]|\[\^/;
/** A line's leading list, quote and heading markers. */
const leadingMarkers = /^[\s\-+*>#\d.)]*/;

const known = new WeakMap<Transaction, boolean>();

/**
 * Whether `transaction` only edits prose. Each change stays on one line of a
 * paragraph or heading and starts after the first character of that line's
 * text, so the line keeps its kind of block, and neither the old nor the new
 * line holds code, quote, table, formula or footnote syntax. Structure found
 * in the syntax tree outside such a line is then unchanged apart from moving.
 */
export function proseEdit(transaction: Transaction): boolean {
  let prose = known.get(transaction);
  if (prose === undefined) known.set(transaction, prose = transaction.docChanged && everyChangeIsProse(transaction));
  return prose;
}

function everyChangeIsProse({ startState, state, changes }: Transaction): boolean {
  const tree = syntaxTree(startState);
  let prose = true;
  changes.iterChanges((fromA, toA, fromB, toB) => {
    if (!prose) return;
    const before = startState.doc.lineAt(fromA), after = state.doc.lineAt(fromB);
    prose = toA <= before.to && toB <= after.to
      && fromA - before.from > leadingMarkers.exec(before.text)![0].length
      && !structural.test(before.text) && !structural.test(after.text);
    if (!prose) return;
    let node = tree.resolveInner(fromA, 1);
    while (node.parent && !proseBlocks.has(node.name)) node = node.parent;
    prose = proseBlocks.has(node.name) && node.to >= toA;
  });
  return prose;
}
