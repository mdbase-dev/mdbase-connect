import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { livePreview, markdownMath } from "@mdbase-dev/ui/live-preview";
import { useEffect, useRef, type JSX } from "react";
import { taskText } from "./model";

/** A ticked or cleared task box: the body after it, and the task's text and new state. */
export interface TaskChange {
  readonly body: string;
  readonly task: string;
  readonly done: boolean;
}

/**
 * A record's body as the Editor renders it. Shown, it can only have its task boxes ticked, and
 * only when `onTask` is given; edited, it is the Editor's live preview with undo, and `onDraft`
 * hears each change.
 */
export function MarkdownBody({ text, label, editing = false, onTask, onDraft }: {
  readonly text: string;
  readonly label: string;
  readonly editing?: boolean | undefined;
  readonly onTask?: ((change: TaskChange) => void) | undefined;
  readonly onDraft?: ((text: string) => void) | undefined;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onTask, onDraft });
  handlers.current = { onTask, onDraft };
  const ticking = onTask !== undefined;

  useEffect(() => {
    const mode: Extension = editing
      ? [history(), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.updateListener.of((update) => {
        if (update.docChanged) handlers.current.onDraft?.(update.state.doc.toString());
      })]
      : ticking
        ? [EditorView.editable.of(false), EditorState.transactionFilter.of(onlyTaskBoxes), EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const line = update.state.doc.lineAt(changedAt(update.transactions));
          handlers.current.onTask?.({ body: update.state.doc.toString(), task: taskText(line.text), done: /\[[xX]\]/u.test(line.text) });
        })]
        : [EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          mode,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label }),
          markdown({ base: markdownLanguage, extensions: [markdownMath] }),
          livePreview(),
        ],
      }),
    });
    if (editing) view.focus();
    return () => view.destroy();
  }, [text, label, editing, ticking]);
  return <div className={editing ? "view-body is-editing" : "view-body"} ref={host} />;
}

/**
 * Shown, the body takes only the live preview's task toggle: one `[ ]` box's mark turned to `x`
 * or back. Anything else (a key the preview's keymap answers, say) is dropped.
 */
function onlyTaskBoxes(transaction: Transaction): Transaction | readonly [] {
  if (!transaction.docChanged) return transaction;
  let box = true;
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const before = transaction.startState.sliceDoc(from - 1, to + 1);
    box &&= to - from === 1 && /^\[[ xX]\]$/u.test(before) && /^[ x]$/u.test(inserted.toString());
  });
  return box ? transaction : [];
}

/** Where the last change landed in the document after it. */
function changedAt(transactions: readonly Transaction[]): number {
  let at = 0;
  for (const transaction of transactions) transaction.changes.iterChangedRanges((_fromA, _toA, fromB) => { at = fromB; });
  return at;
}
