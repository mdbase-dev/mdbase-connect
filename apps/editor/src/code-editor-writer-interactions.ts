import type { Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { resolveFileReference } from "./file-reference-resolution";
import { resolveLinkSuggestion, type LinkSuggestion } from "./links";
import { markdownReferenceAt } from "./markdown-references";
import type { CollectionFile } from "./model";
import type { NotePreviewAnchor, NotePreviewSource } from "./NotePreview";

export function writerInteractions(
  suggestions: () => LinkSuggestion[],
  files: () => CollectionFile[],
  currentPath: () => string | undefined,
  onOpenLink: () => ((path: string) => void) | undefined,
  onOpenFileLink: () => ((file: CollectionFile) => void) | undefined,
  onCreateLink: () => ((target: string, label: string | undefined, format: "wikilink" | "markdown") => void) | undefined,
  onPreviewLink: () => ((path: string, anchor: NotePreviewAnchor, source: NotePreviewSource) => void) | undefined,
  onDismissLinkPreview: () => (() => void) | undefined
): Extension {
  let hoveredPath: string | undefined;
  const dismissPreview = (view: EditorView) => {
    if (!hoveredPath) return;
    hoveredPath = undefined;
    view.dom.classList.remove("cm-hovering-link");
    onDismissLinkPreview()?.();
  };
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const task = taskTarget(event);
      if (task && event.button === 0) return toggleTask(view, task, event);
      const renderedLink = event.target instanceof Element
        ? event.target.closest(".cm-rendered-link")
        : null;
      if (!renderedLink || event.button !== 0) return false;
      event.preventDefault();
      return true;
    },
    keydown(event, view) {
      const task = taskTarget(event);
      if (!task || (event.key !== "Enter" && event.key !== " ")) return false;
      return toggleTask(view, task, event);
    },
    click(event, view) {
      const rendered = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".cm-rendered-link")
        : null;
      if (!rendered && !event.metaKey && !event.ctrlKey) return false;
      const renderedFrom = rendered ? Number(rendered.dataset.linkFrom) : undefined;
      const position = Number.isFinite(renderedFrom)
        ? renderedFrom!
        : view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      const link = markdownReferenceAt(view.state.doc.toString(), position, "link", syntaxTree(view.state));
      if (!link) return false;
      if (/^https?:\/\//i.test(link.target)) {
        event.preventDefault();
        window.open(link.target, "_blank", "noopener,noreferrer");
        return true;
      }
      if (!link.target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link.target)) return false;
      const path = resolveLinkSuggestion(link.target, suggestions(), currentPath(), link.format)?.path;
      const file = resolveFileReference(link.target, link.format, files(), currentPath());
      const openLink = onOpenLink();
      const openFileLink = onOpenFileLink();
      const createLink = onCreateLink();
      if (!path && !file && !createLink) return false;
      if (path && !openLink) return false;
      if (file && !openFileLink) return false;
      event.preventDefault();
      dismissPreview(view);
      if (path) openLink?.(path);
      else if (file) openFileLink?.(file);
      else createLink?.(link.target, link.label, link.format);
      return true;
    },
    mousemove(event, view) {
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const path = position === null
        ? undefined
        : internalLinkPathAt(view.state.doc.toString(), position, suggestions(), currentPath());
      if (!path) {
        dismissPreview(view);
        return false;
      }
      if (hoveredPath === path) return false;
      if (hoveredPath) onDismissLinkPreview()?.();
      hoveredPath = path;
      view.dom.classList.add("cm-hovering-link");
      const coordinates = view.coordsAtPos(position ?? 0);
      const anchor: NotePreviewAnchor = {
        left: event.clientX,
        right: event.clientX,
        top: coordinates?.top ?? event.clientY,
        bottom: coordinates?.bottom ?? event.clientY
      };
      onPreviewLink()?.(path, anchor, "editor");
      return false;
    },
    mouseleave(_event, view) {
      dismissPreview(view);
      return false;
    }
  });
}

function taskTarget(event: Event): HTMLElement | null {
  return event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-task-checkbox") : null;
}

function toggleTask(view: EditorView, target: HTMLElement, event: Event): boolean {
  const from = Number(target.dataset.taskFrom);
  if (!Number.isFinite(from)) return false;
  const source = view.state.sliceDoc(from, from + 3);
  if (!/^\[[ xX]\]$/.test(source)) return false;
  event.preventDefault();
  view.dispatch({
    changes: { from: from + 1, to: from + 2, insert: source[1].toLocaleLowerCase() === "x" ? " " : "x" },
    scrollIntoView: true,
    userEvent: "input"
  });
  view.focus();
  return true;
}

export function internalLinkPathAt(
  doc: string,
  position: number,
  suggestions: LinkSuggestion[],
  sourcePath?: string
): string | undefined {
  const link = markdownReferenceAt(doc, position, "link");
  if (!link || /^https?:\/\//i.test(link.target)) return undefined;
  return resolveLinkSuggestion(link.target, suggestions, sourcePath, link.format)?.path;
}
