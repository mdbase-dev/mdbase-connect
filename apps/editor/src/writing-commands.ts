import { startCompletion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Rewrites the start of every line a selection touches; `next` returns the replacement for the part `pattern` matched. */
function rewriteLineStarts(view: EditorView, pattern: RegExp, next: (match: RegExpExecArray, lines: RegExpExecArray[]) => string): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const lines = touchedLines(state);
  const matches = lines.map((line) => pattern.exec(line.text)!);
  const changes: ChangeSpec[] = lines.map((line, index) => ({
    from: line.from, to: line.from + matches[index][0].length, insert: next(matches[index], matches)
  }));
  view.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
  return true;
}

function touchedLines(state: EditorState) {
  const seen = new Set<number>();
  return state.selection.ranges.flatMap((range) => {
    const lines = [];
    for (let line = state.doc.lineAt(range.from); ; line = state.doc.line(line.number + 1)) {
      if (!seen.has(line.number)) { seen.add(line.number); lines.push(line); }
      if (line.to >= range.to || line.number === state.doc.lines) break;
    }
    return lines;
  });
}

// Leading indentation and a list marker with an optional task box; group 1 is the indent.
const listStart = /^(\s*)(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;

/** Cycles the lines through a level-two heading, a level-three heading and plain text. */
export function cycleHeading(view: EditorView): boolean {
  return rewriteLineStarts(view, /^(?:(#{1,6})\s+)?/, (_match, all) => {
    const level = all[0][1]?.length ?? 0;
    return level === 0 || level === 1 ? "## " : level === 2 ? "### " : "";
  });
}

/** Makes the lines a bulleted list, or plain text when they all already are. */
export function toggleBulletList(view: EditorView): boolean {
  const bulleted = /^\s*[-*+]\s+(?!\[[ xX]\])/;
  const all = touchedLines(view.state).every((line) => bulleted.test(line.text));
  return rewriteLineStarts(view, listStart, (match) => `${match[1]}${all ? "" : "- "}`);
}

/** Makes the lines tasks, or plain text when they all already are; done tasks stay done. */
export function toggleTask(view: EditorView): boolean {
  const task = /^\s*[-*+]\s+\[[ xX]\]/;
  const all = touchedLines(view.state).every((line) => task.test(line.text));
  return rewriteLineStarts(view, listStart, (match) => {
    if (all) return match[1];
    const done = /\[[xX]\]/.test(match[0]);
    return `${match[1]}- [${done ? "x" : " "}] `;
  });
}

/** Wraps the selection as a note link, or starts one and offers note names. */
export function insertNoteLink(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  if (from !== to) {
    view.dispatch({
      changes: [{ from, insert: "[[" }, { from: to, insert: "]]" }],
      selection: EditorSelection.cursor(to + 4),
      scrollIntoView: true,
      userEvent: "input"
    });
    return true;
  }
  view.dispatch({ changes: { from, insert: "[[" }, selection: EditorSelection.cursor(from + 2), scrollIntoView: true, userEvent: "input.type" });
  startCompletion(view);
  return true;
}

/** Enter on an empty quoted line ends the quote (one level of it), as an empty item ends a list. */
export function exitEmptyQuote(view: EditorView): boolean {
  const { state } = view;
  const { main } = state.selection;
  if (state.readOnly || state.selection.ranges.length > 1 || !main.empty) return false;
  const line = state.doc.lineAt(main.head);
  if (main.head !== line.to || !/^\s*(?:>\s*)+$/.test(line.text)) return false;
  // A blank line inside quoted code is code.
  for (let node = syntaxTree(state).resolveInner(main.head, -1); node; node = node.parent!) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
    if (!node.parent) break;
  }
  const outer = line.text.replace(/\s*>\s*$/, "");
  const insert = outer ? `${outer} ` : "";
  view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: EditorSelection.cursor(line.from + insert.length), scrollIntoView: true, userEvent: "input" });
  return true;
}

const wrapping: Record<string, string> = { "*": "*", "_": "_", "`": "`", "~": "~", "(": ")", "[": "]", "\"": "\"" };

/**
 * Typing an emphasis mark, a backtick, an opening bracket or a quote over selected text
 * wraps the text instead of replacing it, and keeps it selected, so `*` twice makes it bold.
 */
export const wrapSelectionOnType = EditorView.inputHandler.of((view, from, to, text) => {
  const close = wrapping[text];
  const { main } = view.state.selection;
  if (!close || main.empty || from !== main.from || to !== main.to) return false;
  view.dispatch(view.state.changeByRange((range) => range.empty
    ? { changes: { from: range.from, insert: text }, range: EditorSelection.cursor(range.from + text.length) }
    : { changes: [{ from: range.from, insert: text }, { from: range.to, insert: close }], range: EditorSelection.range(range.anchor + 1, range.head + 1) }
  ), { scrollIntoView: true, userEvent: "input.type" });
  return true;
});
