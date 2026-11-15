import { syntaxTree } from "@codemirror/language";
import { StateField } from "@codemirror/state";
import type { Tree } from "@lezer/common";

/**
 * The syntax tree, as a dependency for `EditorView.decorations.compute`. A note
 * is first parsed only near its start; the rest arrives in later transactions
 * that change the tree without changing the text.
 */
export const parsedTree = StateField.define<Tree>({
  create: (state) => syntaxTree(state),
  update: (_tree, transaction) => syntaxTree(transaction.state)
});
