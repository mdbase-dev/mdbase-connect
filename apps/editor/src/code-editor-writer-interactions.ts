import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { resolveFileReference } from "./file-references";
import type { LinkSuggestion } from "./links";
import type { CollectionFile } from "./model";
import type { NotePreviewAnchor, NotePreviewSource } from "./NotePreview";

interface MarkdownLinkTarget {
  target: string;
  label?: string;
  format: "wikilink" | "markdown";
}

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
      const link = markdownLinkAt(view.state.doc.toString(), position);
      if (!link) return false;
      if (/^https?:\/\//i.test(link.target)) {
        event.preventDefault();
        window.open(link.target, "_blank", "noopener,noreferrer");
        return true;
      }
      if (!link.target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link.target)) return false;
      const path = resolveSuggestionPath(link.target, suggestions(), currentPath());
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

function markdownLinkAt(doc: string, position: number): MarkdownLinkTarget | undefined {
  const lineStart = doc.lastIndexOf("\n", position - 1) + 1;
  const lineEnd = doc.indexOf("\n", position);
  const end = lineEnd < 0 ? doc.length : lineEnd;
  const line = doc.slice(lineStart, end);
  for (const match of line.matchAll(/\[\[([^\]]+)\]\]|\[([^\]]*)\]\(([^)]+)\)/g)) {
    const from = lineStart + match.index;
    const to = from + match[0].length;
    if (position < from || position > to || doc[from - 1] === "!") continue;
    if (match[1] !== undefined) {
      const [target, label] = match[1].split("|", 2);
      return {
        target: target.split("#", 1)[0].trim(),
        label: label?.trim() || undefined,
        format: "wikilink"
      };
    }
    return {
      target: (match[3] ?? "").replace(/^<|>$/g, "").split("#", 1)[0].trim(),
      label: match[2]?.trim() || undefined,
      format: "markdown"
    };
  }
  return undefined;
}

export function internalLinkPathAt(
  doc: string,
  position: number,
  suggestions: LinkSuggestion[],
  sourcePath?: string
): string | undefined {
  const link = markdownLinkAt(doc, position);
  if (!link || /^https?:\/\//i.test(link.target)) return undefined;
  return resolveSuggestionPath(link.target, suggestions, sourcePath);
}

function resolveSuggestionPath(target: string, suggestions: LinkSuggestion[], sourcePath?: string): string | undefined {
  const normalized = target.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\.md$/i, "").toLocaleLowerCase();
  const exact = suggestions.find((suggestion) => suggestion.path.replace(/\.md$/i, "").toLocaleLowerCase() === normalized);
  if (exact) return exact.path;
  const sourceFolder = sourcePath?.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const candidates = suggestions.filter((suggestion) => {
    const filename = suggestion.path.split("/").at(-1)?.replace(/\.md$/i, "").toLocaleLowerCase();
    return filename === normalized
      || suggestion.title.toLocaleLowerCase() === normalized
      || suggestion.aliases?.some((alias) => alias.toLocaleLowerCase() === normalized);
  });
  return candidates.sort((left, right) => {
    const leftFolder = left.path.slice(0, Math.max(0, left.path.lastIndexOf("/")));
    const rightFolder = right.path.slice(0, Math.max(0, right.path.lastIndexOf("/")));
    return Number(rightFolder === sourceFolder) - Number(leftFolder === sourceFolder)
      || left.path.length - right.path.length
      || left.path.localeCompare(right.path);
  })[0]?.path;
}
