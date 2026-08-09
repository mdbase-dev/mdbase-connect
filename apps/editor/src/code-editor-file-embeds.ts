import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { FileAssetSnapshot } from "./file-asset-store";
import type { ResolvedFileReference } from "./use-file-assets";

class FileEmbedWidget extends WidgetType {
  private unmountInlinePdf?: () => void;

  constructor(
    readonly reference: ResolvedFileReference,
    readonly open: ((asset: Extract<FileAssetSnapshot, { status: "ready" }>) => void) | undefined
  ) { super(); }

  eq(other: FileEmbedWidget) {
    const current = this.reference.asset;
    const next = other.reference.asset;
    return current.file.fileId === next.file.fileId
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

    if (asset.status === "ready") {
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
      } else {
        const media = document.createElement(asset.file.mediaClass === "audio" ? "audio" : "video");
        media.src = asset.url;
        media.controls = true;
        media.preload = "metadata";
        preview.append(media);
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

export function fileEmbedPresentation(
  references: () => ResolvedFileReference[],
  onOpen: () => ((asset: Extract<FileAssetSnapshot, { status: "ready" }>) => void) | undefined
): Extension {
  return EditorView.decorations.compute(["doc", "selection"], (state) => {
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
  });
}
