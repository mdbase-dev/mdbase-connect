import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Scroll effects only, never document changes or extra undo history. */
export const typewriterScrolling = ViewPlugin.fromClass(class {
  private frame: number | undefined;
  constructor(private view: EditorView) { this.centre(); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.focusChanged || update.geometryChanged) this.centre();
  }
  private centre() {
    if (!this.view.hasFocus || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      if (this.view.hasFocus) this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: "center" }) });
    });
  }
  destroy() { if (this.frame !== undefined) cancelAnimationFrame(this.frame); }
});
