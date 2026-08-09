import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftIcon as ArrowLeft, FileIcon as File, XIcon as X } from "./icons";
import type { FileAssetSnapshot } from "./file-asset-store";
import type { CollectionFile } from "./model";
import { collectionFileTitle, formatFileSize } from "./collection-browser";
import { EmbedPdfViewer } from "./EmbedPdfViewer";

export function FileWorkspace({ file, asset, leadingActions, onBack, onRetry }: {
  file: CollectionFile;
  asset: FileAssetSnapshot;
  leadingActions?: ReactNode;
  onBack: () => void;
  onRetry: () => void;
}) {
  const filename = collectionFileTitle(file);
  return <main className="editor-pane file-workspace" aria-label={`File viewer, ${filename}`}>
    <h1 className="sr-only">{filename}</h1>
    <header className="editor-bar">
      <button className="mobile-back icon-button" aria-label="Back to notes and files" onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      {leadingActions}
      <div className="path-wrap file-workspace-path"><span>{file.path}</span></div>
      <span className="file-workspace-size">{formatFileSize(file.size)}</span>
      {asset.status === "ready" && <a className="file-open-original" href={asset.url} target="_blank" rel="noreferrer">Open original</a>}
    </header>
    <div className={`file-workspace-content file-viewer-${file.mediaClass}`}>
      {asset.status === "ready" ? <FileContent asset={asset} />
        : asset.status === "error" || asset.status === "too_large"
          ? <div className="file-workspace-message"><File aria-hidden="true" /><strong>Couldn’t preview {filename}</strong><span>{asset.error}</span>{asset.status === "error" && <button onClick={onRetry}>Try again</button>}</div>
          : <div className="file-workspace-message" role="status" aria-busy="true"><span className="file-loading-mark" aria-hidden="true" /><strong>Opening {filename}</strong></div>}
    </div>
  </main>;
}

export function FileViewer({ asset, onClose }: {
  asset?: Extract<FileAssetSnapshot, { status: "ready" }>;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!asset) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [asset, onClose]);
  if (!asset) return null;
  const filename = collectionFileTitle(asset.file);
  return createPortal(<div className="file-viewer-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}><section className="file-viewer" role="dialog" aria-modal="true" aria-label={`Preview ${filename}`}>
    <header><div><strong>{filename}</strong><span>{asset.file.path}</span></div><a href={asset.url} target="_blank" rel="noreferrer">Open original</a><button className="icon-button" aria-label="Close file preview" onClick={onClose} autoFocus><X aria-hidden="true" /></button></header>
    <div className={`file-viewer-content file-viewer-${asset.file.mediaClass}`}><FileContent asset={asset} /></div>
  </section></div>, document.body);
}

function FileContent({ asset }: { asset: Extract<FileAssetSnapshot, { status: "ready" }> }) {
  const filename = collectionFileTitle(asset.file);
  if (asset.file.mediaClass === "image") return <img src={asset.url} alt={filename} />;
  if (asset.file.mediaClass === "pdf") return <EmbedPdfViewer src={asset.url} filename={filename} />;
  if (asset.file.mediaClass === "audio") return <audio src={asset.url} controls preload="metadata" aria-label={filename} />;
  if (asset.file.mediaClass === "video") return <video src={asset.url} controls preload="metadata" aria-label={filename} />;
  return <div className="file-workspace-message"><File aria-hidden="true" /><strong>{filename}</strong><span>{formatFileSize(asset.file.size)} · Preview unavailable. Use Open original to view this file.</span></div>;
}
