import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import type { ResolvedNoteEmbed } from "./note-embeds";

class NoteEmbedWidget extends WidgetType {
  constructor(
    readonly reference: ResolvedNoteEmbed,
    readonly open: ((path: string) => void) | undefined
  ) { super(); }

  eq(other: NoteEmbedWidget) {
    return this.reference.status === other.reference.status
      && this.reference.path === other.reference.path
      && this.reference.revision === other.reference.revision
      && this.reference.body === other.reference.body
      && this.reference.anchor === other.reference.anchor
      && this.reference.title === other.reference.title
      && this.reference.error === other.reference.error;
  }

  toDOM() {
    const reference = this.reference;
    const region = document.createElement("section");
    region.className = `cm-note-embed ${reference.status}`;
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", `Transclusion of ${reference.title}`);

    const header = document.createElement("header");
    const title = document.createElement(reference.path && this.open ? "button" : "strong");
    title.textContent = reference.title;
    if (title instanceof HTMLButtonElement) {
      title.type = "button";
      title.setAttribute("aria-label", `Open ${reference.title}`);
      title.addEventListener("click", () => this.open?.(reference.path!));
    }
    const path = document.createElement("span");
    path.textContent = `${reference.path ?? reference.target}${reference.anchor ? `#${reference.anchor}` : ""}`;
    header.append(title, path);
    region.append(header);

    if (reference.status === "ready") {
      const content = document.createElement("div");
      content.className = "cm-note-embed-content";
      renderMarkdownFragment(content, reference.body ?? "");
      region.append(content);
    } else {
      const status = document.createElement("p");
      status.className = "cm-note-embed-status";
      status.setAttribute("role", "status");
      status.textContent = reference.status === "loading"
        ? "Opening transcluded note…"
          : reference.status === "cycle"
            ? "Circular transclusion stopped here."
            : reference.status === "ambiguous"
              ? reference.error ?? "More than one note matches this transclusion."
            : reference.status === "missing_fragment"
            ? "That heading or block does not exist in this note."
            : reference.status === "missing"
              ? "This transcluded note could not be resolved."
              : reference.error ?? "The transcluded note could not be opened.";
      region.append(status);
    }
    return region;
  }

  ignoreEvent(event: Event) {
    return event.target instanceof Element && Boolean(event.target.closest("button"));
  }
}

export function noteEmbedPresentation(
  references: () => ResolvedNoteEmbed[],
  onOpen: () => ((path: string) => void) | undefined,
  onVisible: () => ((keys: string[]) => void) | undefined
): Extension {
  return [
    EditorView.decorations.compute(["doc", "selection"], (state) => {
      const activeLines = new Set(state.selection.ranges.map((range) => state.doc.lineAt(range.head).from));
      const ranges = references().flatMap((reference): Range<Decoration>[] => {
        if (reference.to > state.doc.length) return [];
        const line = state.doc.lineAt(reference.from);
        if (activeLines.has(line.from)) return [];
        return [Decoration.replace({
          block: true,
          widget: new NoteEmbedWidget(reference, onOpen())
        }).range(line.from, line.to)];
      });
      return Decoration.set(ranges, true);
    }),
    ViewPlugin.fromClass(class {
      private reported = "";

      constructor(view: EditorView) { this.report(view); }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.report(update.view);
      }

      private report(view: EditorView) {
        const keys = references()
          .filter((reference) => view.visibleRanges.some((range) => reference.from <= range.to && reference.to >= range.from))
          .map((reference) => reference.key);
        const fingerprint = keys.join("\n");
        if (fingerprint === this.reported) return;
        this.reported = fingerprint;
        queueMicrotask(() => onVisible()?.(keys));
      }
    })
  ];
}

function renderMarkdownFragment(container: HTMLElement, source: string) {
  const lines = source.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = /^\s*(```+|~~~+)\s*([^\s]*)/.exec(line);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${escapeRegExp(fence[1][0])}{${fence[1].length},}\\s*$`).test(lines[index])) {
        content.push(lines[index]);
        index += 1;
      }
      index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[2]) code.dataset.language = fence[2];
      code.textContent = content.join("\n");
      pre.append(code);
      container.append(pre);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      element.textContent = cleanInlineMarkdown(heading[2]);
      container.append(element);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      container.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    const list = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = Boolean(list[2]);
      const root = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(lines[index]);
        if (!item || Boolean(item[2]) !== ordered) break;
        const entry = document.createElement("li");
        const task = /^\[([ xX])\]\s+(.+)$/.exec(item[3]);
        if (task) {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = task[1].toLocaleLowerCase() === "x";
          checkbox.disabled = true;
          entry.append(checkbox, document.createTextNode(cleanInlineMarkdown(task[2])));
        } else entry.textContent = cleanInlineMarkdown(item[3]);
        root.append(entry);
        index += 1;
      }
      container.append(root);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const element = document.createElement("blockquote");
      element.textContent = cleanInlineMarkdown(quote.join(" "));
      container.append(element);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index], paragraph.length > 0)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (!paragraph.length) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const element = document.createElement("p");
    element.textContent = cleanInlineMarkdown(paragraph.join(" "));
    container.append(element);
  }
}

function startsBlock(line: string, afterParagraph: boolean): boolean {
  if (!afterParagraph) return false;
  return /^\s*(?:#{1,6}\s|```|~~~|>|(?:[-+*]|\d+[.)])\s+)/.test(line)
    || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_match, target: string, label?: string) => label?.trim() || `Transclusion: ${target.trim()}`)
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_match, target: string, label?: string) => label?.trim() || target.trim())
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`]+/g, "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
