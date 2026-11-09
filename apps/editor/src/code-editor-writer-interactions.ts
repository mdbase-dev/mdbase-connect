import type { Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { internalLink, type LinkTargets } from "./collection-links";
import { markdownReferenceAt } from "./markdown-references";
import type { CollectionFile, LinkTarget } from "./model";
import type { NotePreviewAnchor, NotePreviewSource } from "./NotePreview";

export function writerInteractions(
  linkTargets: () => LinkTargets | undefined,
  files: () => CollectionFile[],
  onOpenLink: () => ((path: string) => void) | undefined,
  onOpenFileLink: () => ((file: CollectionFile) => void) | undefined,
  onCreateLink: () => ((target: string, label: string | undefined, format: "wikilink" | "markdown") => void) | undefined,
  onPreviewLink: () => ((path: string, anchor: NotePreviewAnchor, source: NotePreviewSource) => void) | undefined,
  onDismissLinkPreview: () => (() => void) | undefined
): Extension {
  let hoveredPath: string | undefined;
  // The link under the pointer, as written; a lookup that returns after the
  // pointer has moved on shows nothing.
  let hoveredRaw: string | undefined;
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
      const targets = linkTargets();
      if (!link.target || !internalLink(link.target) || !targets) return false;
      const raw = view.state.sliceDoc(link.from, link.to);
      event.preventDefault();
      dismissPreview(view);
      const follow = (target: LinkTarget) => {
        if (target.kind === "note") onOpenLink()?.(target.path);
        else if (target.kind === "file") {
          const file = files().find(candidate => candidate.path === target.path);
          if (file) onOpenFileLink()?.(file);
        } else if (target.kind === "missing") onCreateLink()?.(link.target, link.label, link.format);
      };
      const known = targets.get(raw);
      if (known) follow(known);
      // A failed lookup is shown on the link by the reference diagnostics.
      else void targets.resolve(raw).then(follow, () => undefined);
      return true;
    },
    mousemove(event, view) {
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const link = position === null ? undefined : internalLinkAt(view.state.doc.toString(), position);
      const targets = linkTargets();
      hoveredRaw = link && targets ? link.raw : undefined;
      if (!link || !targets) {
        dismissPreview(view);
        return false;
      }
      const show = (target: LinkTarget | undefined) => {
        if (hoveredRaw !== link.raw) return;
        if (target?.kind !== "note") {
          dismissPreview(view);
          return;
        }
        if (hoveredPath === target.path) return;
        if (hoveredPath) onDismissLinkPreview()?.();
        hoveredPath = target.path;
        view.dom.classList.add("cm-hovering-link");
        const coordinates = view.coordsAtPos(position ?? 0);
        const anchor: NotePreviewAnchor = {
          left: event.clientX,
          right: event.clientX,
          top: coordinates?.top ?? event.clientY,
          bottom: coordinates?.bottom ?? event.clientY
        };
        onPreviewLink()?.(target.path, anchor, "editor");
      };
      const known = targets.get(link.raw);
      if (known) show(known);
      else void targets.resolve(link.raw).then(show, () => undefined);
      return false;
    },
    mouseleave(_event, view) {
      hoveredRaw = undefined;
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

/** The internal link at `position`, as written in the note: what the hover
 * preview asks the collection about. */
export function internalLinkAt(doc: string, position: number): { raw: string } | undefined {
  const link = markdownReferenceAt(doc, position, "link");
  return link && internalLink(link.target) ? { raw: doc.slice(link.from, link.to) } : undefined;
}
