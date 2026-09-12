import type { EditorView } from "@codemirror/view";

/**
 * Tracks the live writer view per document so lightweight UI (like the document
 * outline) can scroll the lazily loaded CodeMirror instance without importing
 * the editor bundle.
 */
const activeViews = new Map<string, EditorView>();

export function registerActiveEditor(documentId: string, view: EditorView): void {
  activeViews.set(documentId, view);
}

export function unregisterActiveEditor(documentId: string, view: EditorView): void {
  if (activeViews.get(documentId) === view) activeViews.delete(documentId);
}

/** Scrolls the live writer view for `documentId` to the given 1-based line. */
export function revealMarkdownLine(documentId: string | undefined, line: number): void {
  if (!documentId) return;
  const view = activeViews.get(documentId);
  if (!view) return;
  const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
  view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
  view.focus();
}
