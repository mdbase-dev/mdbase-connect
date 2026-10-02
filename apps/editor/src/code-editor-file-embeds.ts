import { EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension, type Range, type Text } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { AttachmentUploader } from "./AttachmentUpload";
import { gatewayError } from "./gateway";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import type { FileAssetSnapshot } from "./file-asset-store";
import { fileAssetKey, isInlinePreviewable, isTextPreviewable } from "./file-reference-resolution";
import type { ResolvedFileReference } from "./use-file-assets";

class FileEmbedWidget extends WidgetType {
  private unmountInlinePdf?: () => void;
  private textRequest?: AbortController;

  constructor(
    readonly reference: ResolvedFileReference,
    readonly open: ((asset: Extract<FileAssetSnapshot, { status: "ready" }>) => void) | undefined
  ) { super(); }

  eq(other: FileEmbedWidget) {
    const current = this.reference.asset;
    const next = other.reference.asset;
    return Boolean(this.open) === Boolean(other.open)
      && current.file.fileId === next.file.fileId
      && current.file.revision === next.file.revision
      && current.status === next.status
      && (current.status !== "ready" || next.status !== "ready" || current.url === next.url)
      && this.reference.label === other.reference.label;
  }

  toDOM() {
    const { asset, label } = this.reference;
    const filename = asset.file.path.split("/").at(-1) ?? asset.file.path;
    const preview = document.createElement("figure");
    preview.className = `cm-file-embed cm-file-embed-${asset.file.mediaClass} ${asset.status}`;
    preview.setAttribute("aria-label", asset.status === "ready" ? `Preview ${filename}` : `Preview ${filename}, ${asset.status.replace("_", " ")}`);

    if (!isInlinePreviewable(asset.file)) {
      const unavailable = document.createElement("div");
      unavailable.className = "cm-file-embed-status";
      unavailable.textContent = `No inline preview is available for ${filename}.`;
      preview.append(unavailable);
    } else if (asset.status === "ready") {
      if (asset.file.mediaClass === "image") {
        const image = document.createElement("img");
        image.src = asset.url;
        image.alt = label ?? filename;
        image.loading = "lazy";
        preview.append(image);
      } else if (asset.file.mediaClass === "pdf") {
        const cover = document.createElement("button");
        cover.type = "button";
        cover.className = "cm-file-embed-pdf-cover";
        cover.setAttribute("aria-label", `Open ${filename}`);
        const mark = document.createElement("span");
        mark.textContent = "PDF";
        const prompt = document.createElement("span");
        prompt.textContent = "Open document";
        cover.append(mark, prompt);
        cover.addEventListener("click", () => this.activatePdf(preview, cover, asset.url, filename));
        preview.append(cover);
      } else if (asset.file.mediaClass === "audio" || asset.file.mediaClass === "video") {
        const media = document.createElement(asset.file.mediaClass === "audio" ? "audio" : "video");
        media.src = asset.url;
        media.controls = true;
        media.preload = "metadata";
        preview.append(media);
      } else if (isTextPreviewable(asset.file)) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = "Opening text preview…";
        pre.append(code);
        preview.append(pre);
        const request = new AbortController();
        this.textRequest = request;
        void fetch(asset.url, { signal: request.signal })
          .then((response) => response.text())
          .then((text) => {
            if (!request.signal.aborted && code.isConnected) code.textContent = text;
          })
          .catch((error: unknown) => {
            if (!request.signal.aborted && code.isConnected) {
              code.textContent = error instanceof Error ? error.message : "The text preview could not be opened.";
            }
          });
      }
    } else {
      const status = document.createElement("div");
      status.className = "cm-file-embed-status";
      status.setAttribute("role", "status");
      status.textContent = asset.status === "loading" || asset.status === "idle"
        ? `Opening ${filename}`
        : asset.error;
      preview.append(status);
    }

    const caption = document.createElement("figcaption");
    const name = document.createElement("strong");
    const detail = document.createElement("span");
    name.textContent = label ?? filename;
    detail.textContent = asset.file.path;
    caption.append(name, detail);
    if (asset.status === "ready" && asset.file.mediaClass !== "audio" && asset.file.mediaClass !== "video" && asset.file.mediaClass !== "pdf" && this.open) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "cm-file-embed-open";
      open.setAttribute("aria-label", `Open ${filename}`);
      open.textContent = "Open";
      open.addEventListener("click", (event) => {
        event.stopPropagation();
        this.open?.(asset);
      });
      caption.append(open);
    }
    preview.append(caption);
    return preview;
  }

  ignoreEvent(event: Event) {
    return event.target instanceof Element && Boolean(event.target.closest("button, audio, video, .cm-file-embed-pdf-viewer"));
  }

  destroy() {
    this.textRequest?.abort("Text embed released");
    this.unmountInlinePdf?.();
  }

  private activatePdf(preview: HTMLElement, cover: HTMLElement, src: string, filename: string) {
    if (preview.classList.contains("cm-file-embed-active")) return;
    preview.classList.add("cm-file-embed-active");
    preview.setAttribute("aria-label", `PDF embed, ${filename}`);
    const viewer = document.createElement("div");
    viewer.className = "cm-file-embed-pdf-viewer";
    viewer.tabIndex = 0;
    viewer.setAttribute("role", "region");
    viewer.setAttribute("aria-label", `Embedded PDF, ${filename}`);
    cover.replaceWith(viewer);
    viewer.focus({ preventScroll: true });
    void import("./inline-pdf-viewer").then(({ mountInlinePdfViewer }) => {
      if (!viewer.isConnected) return;
      const root = mountInlinePdfViewer(viewer, src, filename);
      this.unmountInlinePdf = () => root.unmount();
    });
  }
}

interface PendingAttachment {
  id: number;
  position: number;
  file: File;
  error?: string;
  retry: () => void;
  remove: () => void;
}

const changeAttachment = StateEffect.define<PendingAttachment>();
const removeAttachment = StateEffect.define<number>();
const pendingAttachments = StateField.define<readonly PendingAttachment[]>({
  create: () => [],
  update(jobs, transaction) {
    // These are view-local anchors, never placeholder text in a saved note.
    const completed = transaction.effects.find((effect) => effect.is(removeAttachment))?.value;
    let next = jobs.filter((job) => {
      let deleted = false;
      transaction.changes.iterChangedRanges((from, to) => {
        if (from !== to && from <= job.position && to >= job.position) deleted = true;
      });
      return !deleted;
    }).map((job) => ({ ...job, position: transaction.changes.mapPos(job.position,
      typeof completed === "number" && job.id < completed ? -1 : 1) }));
    for (const effect of transaction.effects) {
      if (effect.is(removeAttachment)) next = next.filter((job) => job.id !== effect.value);
      if (effect.is(changeAttachment)) {
        next = next.filter((job) => job.id !== effect.value.id);
        next.push(effect.value);
      }
    }
    return next;
  }
});

class AttachmentWidget extends WidgetType {
  constructor(readonly job: PendingAttachment, readonly disabled: boolean) { super(); }
  eq(other: AttachmentWidget) {
    return this.job.id === other.job.id && this.job.error === other.job.error && this.disabled === other.disabled;
  }
  toDOM() {
    const widget = document.createElement("span");
    widget.className = `cm-attachment-upload${this.job.error ? " is-error" : ""}`;
    const label = document.createElement("span");
    label.setAttribute("role", "status");
    label.textContent = this.job.error
      ? `Couldn’t upload ${this.job.file.name}. ${this.job.error}`
      : `Uploading ${this.job.file.name}…`;
    widget.append(label);
    for (const [text, action] of this.job.error
      ? [["Retry", this.job.retry], ["Remove", this.job.remove]] as const
      : [["Remove", this.job.remove]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mdbase-button is-tertiary";
      button.textContent = text;
      button.setAttribute("aria-label", `${text} upload of ${this.job.file.name}`);
      button.disabled = this.disabled;
      button.addEventListener("click", action);
      widget.append(button);
    }
    return widget;
  }
  ignoreEvent() { return true; }
}

export function blockAttachmentInsertion(doc: Text, from: number, to: number, reference: string): string {
  const before = doc.sliceString(Math.max(0, from - 1), from);
  const after = doc.sliceString(to, to + 1);
  return `${before && before !== "\n" ? "\n\n" : ""}${reference}${after && after !== "\n" ? "\n\n" : ""}`;
}

/** Paste/drop shares the menu's uploader, but owns only editor-local insertion anchors. */
export function attachmentCapture(uploader: () => AttachmentUploader | undefined): Extension {
  return [pendingAttachments, EditorView.decorations.compute([pendingAttachments, EditorState.readOnly], (state) =>
    Decoration.set(state.field(pendingAttachments).map((job) => Decoration.widget({
      side: 1, widget: new AttachmentWidget(job, state.readOnly)
    }).range(job.position)), true)
  ), ViewPlugin.fromClass(class {
    private sequence = 0;
    private destroyed = false;
    constructor(readonly view: EditorView) {}
    destroy() {
      this.destroyed = true;
      this.view.dom.classList.remove("is-file-drag-over");
    }
    update() {
      if (!this.enabled()) this.view.dom.classList.remove("is-file-drag-over");
    }
    enabled() { return !this.view.state.readOnly && Boolean(uploader()); }
    add(files: readonly File[], position: number) {
      const jobs = files.map((file): PendingAttachment => {
        const id = ++this.sequence;
        return { id, file, position, retry: () => void this.run(id), remove: () => {
          if (!this.destroyed && this.enabled()) this.view.dispatch({ effects: removeAttachment.of(id) });
        } };
      });
      this.view.dispatch({ effects: jobs.map((job) => changeAttachment.of(job)) });
      // Preserve ordering for files dropped at the same anchor.
      void (async () => { for (const job of jobs) await this.run(job.id); })();
    }
    async run(id: number) {
      if (this.destroyed || !this.enabled()) return;
      const upload = uploader()!;
      const job = this.view.state.field(pendingAttachments).find((job) => job.id === id);
      if (!job) return;
      this.view.dispatch({ effects: changeAttachment.of({ ...job, error: undefined }) });
      try {
        const reference = await upload(job.file);
        if (this.destroyed) return;
        const current = this.view.state.field(pendingAttachments).find((job) => job.id === id);
        if (!current) return; // Removal/navigation must never insert a late reference.
        if (!this.enabled()) throw new Error("The note is no longer editable.");
        const insert = blockAttachmentInsertion(this.view.state.doc, current.position, current.position, reference);
        const selection = this.view.state.selection.main;
        this.view.dispatch({
          changes: { from: current.position, insert },
          // Normal paste advances a caret still at the insertion point. A caret
          // moved elsewhere during upload remains owned by the writer.
          selection: selection.empty && selection.head === current.position
            ? EditorSelection.cursor(current.position + insert.length) : undefined,
          effects: removeAttachment.of(id),
          annotations: [Transaction.userEvent.of("input.attachment"), isolateHistory.of("full")]
        });
      } catch (error) {
        if (this.destroyed) return;
        const current = this.view.state.field(pendingAttachments).find((job) => job.id === id);
        if (current) this.view.dispatch({ effects: changeAttachment.of({ ...current, error: gatewayError(error) }) });
      }
    }
  }, { eventHandlers: {
    paste(event) {
      if (!this.enabled() || !event.clipboardData) return false;
      const files = clipboardAttachments(event.clipboardData);
      if (!files.length) return false;
      event.preventDefault();
      this.add(files, this.view.state.selection.main.from);
      return true;
    },
    dragover(event) {
      if (!this.enabled() || !event.dataTransfer?.types.includes("Files")) return false;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      this.view.dom.classList.add("is-file-drag-over");
      return true;
    },
    dragleave(event) {
      if (!(event.relatedTarget instanceof Node) || !this.view.dom.contains(event.relatedTarget)) {
        this.view.dom.classList.remove("is-file-drag-over");
      }
    },
    drop(event) {
      this.view.dom.classList.remove("is-file-drag-over");
      if (!this.enabled() || !event.dataTransfer?.files.length) return false;
      const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      event.preventDefault();
      this.add([...event.dataTransfer.files], position);
      return true;
    }
  } })];
}

export function clipboardAttachments(data: Pick<DataTransfer, "files" | "items">, now = new Date()): File[] {
  const files = data.files.length ? [...data.files]
    : [...data.items].flatMap((item) => {
      const file = item.kind === "file" ? item.getAsFile() : null;
      return file ? [file] : [];
    });
  return files.map((file) => {
    if (!file.type.startsWith("image/")) return file;
    const pad = (value: number) => String(value).padStart(2, "0");
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
    const extension = file.name.match(/\.([a-z0-9]+)$/iu)?.[1]
      ?? ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" }[file.type] ?? "img");
    return new File([file], `Pasted image ${timestamp}.${extension}`, { type: file.type, lastModified: file.lastModified });
  });
}

export function fileEmbedPresentation(
  references: () => ResolvedFileReference[],
  onOpen: () => ((asset: Extract<FileAssetSnapshot, { status: "ready" }>) => void) | undefined,
  onVisible: () => ((keys: string[]) => void) | undefined = () => undefined
): Extension {
  return [
    EditorView.decorations.compute(["doc", "selection"], (state) => {
      const activeLines = new Set(state.selection.ranges.map((range) => state.doc.lineAt(range.head).from));
      const ranges = references().flatMap((reference): Range<Decoration>[] => {
        if (!reference.block || reference.to > state.doc.length) return [];
        const line = state.doc.lineAt(reference.from);
        if (activeLines.has(line.from)) return [];
        return [Decoration.replace({
          block: true,
          widget: new FileEmbedWidget(reference, onOpen())
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
          .map((reference) => fileAssetKey(reference.file));
        const fingerprint = keys.join("\n");
        if (fingerprint === this.reported) return;
        this.reported = fingerprint;
        queueMicrotask(() => onVisible()?.(keys));
      }
    })
  ];
}
