import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inlinePreview, type LivePreviewOptions } from "./live-preview/inline.js";
import { livePreviewKeys } from "./live-preview/keys.js";
import { tablePreview } from "./live-preview/table.js";
import { blockPreview } from "./live-preview/blocks.js";
import { revealTracking } from "./live-preview/reveal.js";

export type { LivePreviewLink, LivePreviewOptions } from "./live-preview/inline.js";
export { isRevealed, revealField as livePreviewReveal } from "./live-preview/reveal.js";
export { indentListItem, outdentListItem } from "./live-preview/keys.js";

/**
 * Live preview for a CodeMirror Markdown editor: the note reads as rendered
 * text, and each element shows its Markdown only while the selection touches
 * it. Pair it with `@mdbase-dev/ui/live-preview.css` and the `markdown()`
 * language (GFM, for tasks, strikethrough and tables).
 *
 * Rendered links carry `data-link-from` (the link's source offset) and
 * `data-link-format`; opening them is the app's choice. App widgets, such as
 * embeds, should follow the same rule through `isRevealed`.
 */
export function livePreview(options: LivePreviewOptions = {}): Extension {
  return [revealTracking(), blockPreview(), inlinePreview(options), tablePreview(), livePreviewKeys, taskToggle];
}

const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    return event.button === 0 && toggleTask(view, event);
  },
  keydown(event, view) {
    return (event.key === "Enter" || event.key === " ") && toggleTask(view, event);
  }
});

function toggleTask(view: EditorView, event: Event): boolean {
  const box = event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-lp-task") : null;
  const from = Number(box?.dataset.taskFrom);
  if (!box || !Number.isFinite(from)) return false;
  const source = view.state.sliceDoc(from, from + 3);
  if (!/^\[[ xX]\]$/.test(source) || view.state.readOnly) return false;
  event.preventDefault();
  view.dispatch({
    changes: { from: from + 1, to: from + 2, insert: source[1] === " " ? "x" : " " },
    userEvent: "input"
  });
  view.focus();
  return true;
}
