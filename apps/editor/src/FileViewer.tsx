import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useMemo, useState, type ReactNode } from "react";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { ArrowLeftIcon as ArrowLeft, FileIcon as File, XIcon as X } from "./icons";
import { isReadOnlyMarkdownFile, originalPresentation, type FileAssetSnapshot } from "./file-asset-store";
import { fileAssetKey } from "./file-reference-resolution";
import { HTML_IFRAME_SANDBOX, isHtmlPreviewFile, MAX_HTML_PREVIEW_BYTES, prepareHtmlPreviewDocument, truncateHtmlSource } from "./html-preview";
import { ReadOnlyMarkdown } from "./read-only-markdown";
import type { CollectionFile } from "./model";
import { collectionFileTitle, formatFileSize } from "./collection-browser";
import { EmbedPdfViewer } from "./EmbedPdfViewer";

type HtmlViewMode = "preview" | "source";

function useHtmlViewMode(file: CollectionFile | undefined): [HtmlViewMode, (mode: HtmlViewMode) => void] {
  const key = file ? fileAssetKey(file) : "";
  const [state, setState] = useState<{ key: string; mode: HtmlViewMode }>({ key, mode: "preview" });
  const mode = state.key === key ? state.mode : "preview";
  return [mode, (next) => setState({ key, mode: next })];
}

function fileViewerClass(file: CollectionFile, htmlView: HtmlViewMode, hasHtmlSource: boolean): string {
  if (isReadOnlyMarkdownFile(file)) return "markdown";
  if (isHtmlPreviewFile(file) && hasHtmlSource) return htmlView === "source" ? "html-source" : "html";
  return file.mediaClass;
}

export function FileWorkspace({ file, asset, background = false, leadingActions, onBack, onRetry }: {
  file: CollectionFile;
  asset: FileAssetSnapshot;
  /** In an editor pane without the focus. */
  background?: boolean;
  leadingActions?: ReactNode;
  onBack: () => void;
  onRetry: () => void;
}) {
  useLingui();
  const filename = collectionFileTitle(file);
  const [htmlView, setHtmlView] = useHtmlViewMode(file);
  const hasHtmlSource = asset.status === "ready" && isHtmlPreviewFile(asset.file) && asset.sourceText !== undefined;
  return <section className="editor-pane file-workspace" data-focused={background ? undefined : true}>
    <h1 className="sr-only">{filename}</h1>
    <header className="editor-bar">
      <button className="mobile-back icon-button" aria-label={t`Back to notes and files`} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      {leadingActions}
      <div className="path-wrap file-workspace-path"><span>{file.path}</span></div>
      <span className="file-workspace-size">{formatFileSize(file.size)}</span>
      {hasHtmlSource && <HtmlViewSwitch mode={htmlView} onChange={setHtmlView} />}
      {asset.status === "ready" && <OpenOriginal className="file-open-original" asset={asset} />}
    </header>
    <div className={`file-workspace-content file-viewer-${fileViewerClass(file, htmlView, hasHtmlSource)}`}>
      {asset.status === "ready" ? <FileContent asset={asset} htmlView={htmlView} />
        : asset.status === "error" || asset.status === "too_large"
          ? <div className="file-workspace-message"><File aria-hidden="true" /><strong><Trans>Couldn’t preview {filename}</Trans></strong><span>{asset.error}</span>{asset.status === "error" && <button onClick={onRetry}><Trans>Try again</Trans></button>}</div>
          : <div className="file-workspace-message" role="status" aria-busy="true"><strong><Trans>Opening {filename}</Trans></strong><span><Trans>Reading file content…</Trans></span></div>}
    </div>
  </section>;
}

export function FileViewer({ asset, onClose }: {
  asset?: Extract<FileAssetSnapshot, { status: "ready" }>;
  onClose: () => void;
}) {
  useLingui();
  const [htmlView, setHtmlView] = useHtmlViewMode(asset?.file);
  if (!asset) return null;
  const filename = collectionFileTitle(asset.file);
  const hasHtmlSource = isHtmlPreviewFile(asset.file) && asset.sourceText !== undefined;
  return <Dialog open className="file-viewer" title={t`Preview ${filename}`} onClose={onClose}>
    <header><div><strong>{filename}</strong><span>{asset.file.path}</span></div>{hasHtmlSource && <HtmlViewSwitch mode={htmlView} onChange={setHtmlView} />}<OpenOriginal asset={asset} /><button className="icon-button" aria-label={t`Close file preview`} onClick={onClose} data-autofocus><X aria-hidden="true" /></button></header>
    <div className={`file-viewer-content file-viewer-${fileViewerClass(asset.file, htmlView, hasHtmlSource)}`}><FileContent asset={asset} htmlView={htmlView} /></div>
  </Dialog>;
}

function HtmlViewSwitch({ mode, onChange }: { mode: HtmlViewMode; onChange: (mode: HtmlViewMode) => void }) {
  useLingui();
  return <div className="file-view-switch" role="group" aria-label={t`HTML file view`}>
    <button type="button" className={mode === "preview" ? "selected" : ""} aria-pressed={mode === "preview"} onClick={() => onChange("preview")}><Trans context="HTML file view mode">Preview</Trans></button>
    <button type="button" className={mode === "source" ? "selected" : ""} aria-pressed={mode === "source"} onClick={() => onChange("source")}><Trans context="HTML file view mode">Source</Trans></button>
  </div>;
}

/** Only inert originals open in a new tab; every other file is downloaded. */
function OpenOriginal({ asset, className }: { asset: Extract<FileAssetSnapshot, { status: "ready" }>; className?: string }) {
  return originalPresentation(asset.file).inline
    ? <a className={className} href={asset.url} target="_blank" rel="noreferrer"><Trans>Open original</Trans></a>
    : <a className={className} href={asset.url} download={collectionFileTitle(asset.file)}><Trans>Open original</Trans></a>;
}

function HtmlFilePreview({ source, filename, mode }: { source: string; filename: string; mode: HtmlViewMode }) {
  useLingui();
  const srcDoc = useMemo(() => (mode === "preview" ? prepareHtmlPreviewDocument(source) : undefined), [mode, source]);
  const truncatedSource = useMemo(() => (mode === "source" ? truncateHtmlSource(source) : undefined), [mode, source]);
  if (mode === "source" && truncatedSource) {
    return <div className="file-html-source" role="region" aria-label={t`HTML source, ${filename}`} tabIndex={0}>
      {truncatedSource.truncated && <p className="file-html-source-notice"><Trans>Preview truncated for display. The whole verified original is available using Open original.</Trans></p>}
      <pre><code>{truncatedSource.text}</code></pre>
    </div>;
  }
  return <iframe
    className="file-html-frame"
    title={t`HTML preview, ${filename}`}
    sandbox={HTML_IFRAME_SANDBOX}
    referrerPolicy="no-referrer"
    srcDoc={srcDoc}
  />;
}

function FileContent({ asset, htmlView }: { asset: Extract<FileAssetSnapshot, { status: "ready" }>; htmlView: HtmlViewMode }) {
  useLingui();
  const filename = collectionFileTitle(asset.file);
  // Exact profiles take precedence over contradictory MIME/media metadata.
  // Never instantiate a media/embed or note editor for unindexed Markdown.
  if (isReadOnlyMarkdownFile(asset.file)) return asset.sourceText !== undefined
    ? <ReadOnlyMarkdown source={asset.sourceText} byteLength={asset.file.size} />
    : <div className="file-workspace-message"><Trans>Markdown preview unavailable.</Trans></div>;
  if (asset.file.mediaClass === "image") return <img src={asset.url} alt={filename} />;
  if (asset.file.mediaClass === "pdf") return <EmbedPdfViewer src={asset.url} filename={filename} />;
  if (asset.file.mediaClass === "audio") return <audio src={asset.url} controls preload="metadata" aria-label={filename} />;
  if (asset.file.mediaClass === "video") return <video src={asset.url} controls preload="metadata" aria-label={filename} />;
  if (isHtmlPreviewFile(asset.file)) {
    if (asset.sourceText !== undefined) return <HtmlFilePreview source={asset.sourceText} filename={filename} mode={htmlView} />;
    if (asset.file.size > MAX_HTML_PREVIEW_BYTES) {
      return <div className="file-workspace-message"><File aria-hidden="true" /><strong>{filename}</strong><span><Trans>{formatFileSize(asset.file.size)} · HTML preview is limited to {formatFileSize(MAX_HTML_PREVIEW_BYTES)}. Use Open original to view this file.</Trans></span></div>;
    }
  }
  return <div className="file-workspace-message"><File aria-hidden="true" /><strong>{filename}</strong><span><Trans>{formatFileSize(asset.file.size)} · Preview unavailable. Use Open original to view this file.</Trans></span></div>;
}
