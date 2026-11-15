import type { EditorView } from "@codemirror/view";
import { WidgetType } from "@codemirror/view";
import { t } from "@lingui/core/macro";
import type { MountOptions, Mounted } from "pele/lazy";
import "../i18n.js";

/**
 * A Mermaid diagram, rendered by Pele in place of its fenced source while the
 * selection is elsewhere. Pele and each diagram type load on first use, so a
 * note without diagrams never fetches them.
 *
 * Diagram text is untrusted: Pele escapes it and filters styles and links, the
 * render options are fixed here (never from the note), remote images are off,
 * and links only open in a new tab.
 */
export function isDiagramLanguage(language: string): boolean {
  return language.toLowerCase() === "mermaid";
}

let renderer: Promise<typeof import("pele/lazy")> | undefined;
function loadRenderer() {
  // A failed chunk load is retried by the next diagram rather than cached.
  return renderer ??= import("pele/lazy").catch((error: unknown) => {
    renderer = undefined;
    throw error;
  });
}

/** Last rendered height per source, so a re-created widget reserves its space before rendering. */
const heights = new Map<string, number>();
const HEIGHT_ENTRIES = 256;
function rememberHeight(source: string, height: number) {
  heights.delete(source);
  heights.set(source, height);
  if (heights.size > HEIGHT_ENTRIES) heights.delete(heights.keys().next().value!);
}

interface MountState { mounted?: Mounted; destroyed: boolean }
const mounts = new WeakMap<HTMLElement, MountState>();

function renderOptions(view: EditorView, box: HTMLElement, source: string): MountOptions {
  return {
    images: false,
    linkSchemes: ["http", "https", "mailto"],
    linkRel: "noopener noreferrer",
    zoom: { labels: { zoomIn: t`Zoom in`, zoomOut: t`Zoom out`, reset: t`Reset zoom` } },
    onRender: () => view.requestMeasure({
      read: () => box.offsetHeight,
      write: (height) => {
        if (height > 0) rememberHeight(source, height);
        box.style.minHeight = "";
      }
    })
  };
}

export class DiagramWidget extends WidgetType {
  constructor(readonly source: string) { super(); }

  eq(other: DiagramWidget) { return this.source === other.source; }

  get estimatedHeight() { return heights.get(this.source) ?? -1; }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-lp-diagram";
    const height = heights.get(this.source);
    if (height) box.style.minHeight = `${height}px`;
    const canvas = document.createElement("div");
    canvas.className = "cm-lp-diagram-canvas";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-lp-diagram-edit";
    edit.textContent = t({ message: "Edit", context: "diagram" });
    edit.setAttribute("aria-label", t`Edit diagram source`);
    edit.addEventListener("click", () => editSource(view, box));
    box.addEventListener("click", openLink);
    box.append(canvas, edit);

    const state: MountState = { destroyed: false };
    mounts.set(box, state);
    loadRenderer().then(({ mountAsync }) => {
      if (state.destroyed) return;
      return mountAsync(canvas, this.source, renderOptions(view, box, this.source)).then((mounted) => {
        if (state.destroyed) mounted.destroy();
        else state.mounted = mounted;
      });
    }).catch(() => {
      if (state.destroyed) return;
      box.style.minHeight = "";
      canvas.className = "cm-lp-diagram-canvas cm-lp-diagram-failed";
      canvas.textContent = t`The diagram could not be shown. Check your connection and reopen the note.`;
    });
    return box;
  }

  destroy(dom: HTMLElement) {
    const state = mounts.get(dom);
    if (!state) return;
    state.destroyed = true;
    state.mounted?.destroy();
  }

  ignoreEvent() { return true; }
}

/** Puts the caret on the first line of the diagram's source, which reveals it. */
function editSource(view: EditorView, box: HTMLElement) {
  const fence = view.state.doc.lineAt(view.posAtDOM(box));
  view.dispatch({ selection: { anchor: Math.min(fence.to + 1, view.state.doc.length) }, scrollIntoView: true });
  view.focus();
}

/** Links never navigate the app: web and mail links open in a new tab, anything else is inert. */
function openLink(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (/^(https?|mailto):/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
}
