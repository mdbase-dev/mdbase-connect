import type { Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { LinkTargets } from "./collection-links";
import { internalLink } from "./links";
import { markdownReferenceAt } from "./markdown-references";
import type { CollectionFile, LinkTarget } from "./model";
import type { NotePreviewAnchor, NotePreviewSource } from "./NotePreview";

/** Where a followed note link opens: in a new tab, in the other pane, or (unset) in place. */
export interface LinkOpening { where?: "tab" | "beside" }

export function writerInteractions(
  linkTargets: () => LinkTargets | undefined,
  files: () => CollectionFile[],
  onOpenLink: () => ((path: string, options?: LinkOpening) => void) | undefined,
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
  /** Follows the link clicked at `position`: a note opens in place, or `where` asks. */
  const follow = (event: MouseEvent, view: EditorView, position: number, where?: LinkOpening["where"]): boolean => {
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
    const open = (target: LinkTarget) => {
      if (target.kind === "note") onOpenLink()?.(target.path, { where });
      else if (target.kind === "file") {
        const file = files().find(candidate => candidate.path === target.path);
        if (file) onOpenFileLink()?.(file);
      } else if (target.kind === "missing") onCreateLink()?.(link.target, link.label, link.format);
    };
    const known = targets.get(raw);
    if (known) open(known);
    // A failed lookup is shown on the link by the reference diagnostics.
    else void targets.resolve(raw).then(open, () => undefined);
    return true;
  };
  const renderedLink = (event: MouseEvent) => event.target instanceof Element
    ? event.target.closest<HTMLElement>(".cm-lp-link") ?? undefined
    : undefined;
  return EditorView.domEventHandlers({
    mousedown(event) {
      // The middle button opens a rendered link in a new tab; its press would otherwise paste or scroll.
      if (!renderedLink(event) || (event.button !== 0 && event.button !== 1)) return false;
      event.preventDefault();
      return true;
    },
    // A rendered link follows on a click, and opens in a new tab with Ctrl or ⌘. The source of a link
    // follows only with Ctrl or ⌘, since a plain click there places the cursor. Either opens to the side
    // with Alt as well.
    click(event, view) {
      const rendered = renderedLink(event);
      const modifier = event.metaKey || event.ctrlKey;
      if (!rendered && !modifier) return false;
      const renderedFrom = rendered ? Number(rendered.dataset.linkFrom) : undefined;
      const position = Number.isFinite(renderedFrom)
        ? renderedFrom!
        : view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      return follow(event, view, position, modifier && event.altKey ? "beside" : rendered && modifier ? "tab" : undefined);
    },
    auxclick(event, view) {
      const position = Number(renderedLink(event)?.dataset.linkFrom);
      if (event.button !== 1 || !Number.isFinite(position)) return false;
      return follow(event, view, position, "tab");
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

/** The internal link at `position`, as written in the note: what the hover
 * preview asks the collection about. */
export function internalLinkAt(doc: string, position: number): { raw: string } | undefined {
  const link = markdownReferenceAt(doc, position, "link");
  return link && internalLink(link.target) ? { raw: doc.slice(link.from, link.to) } : undefined;
}
