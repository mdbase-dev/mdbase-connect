import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useId, type ReactNode } from "react";
import { Dialog } from "./Dialog";
import { ArrowLeftIcon as ArrowLeft, FileIcon as File, XIcon as X } from "./icons";
import { isReadOnlyMarkdownFile, type FileAssetSnapshot } from "./file-asset-store";
import { ReadOnlyMarkdown } from "./read-only-markdown";
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
  useLingui();
  const filename = collectionFileTitle(file);
  return <main className="editor-pane file-workspace" aria-label={t`File viewer, ${filename}`}>
    <h1 className="sr-only">{filename}</h1>
    <header className="editor-bar">
      <button className="mobile-back icon-button" aria-label={t`Back to notes and files`} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>
      {leadingActions}
      <div className="path-wrap file-workspace-path"><span>{file.path}</span></div>
      <span className="file-workspace-size">{formatFileSize(file.size)}</span>
      {asset.status === "ready" && <a className="file-open-original" href={asset.url} target="_blank" rel="noreferrer"><Trans>Open original</Trans></a>}
    </header>
    <div className={`file-workspace-content file-viewer-${isReadOnlyMarkdownFile(file) ? "markdown" : file.mediaClass}`}>
      {asset.status === "ready" ? <FileContent asset={asset} />
        : asset.status === "error" || asset.status === "too_large"
          ? <div className="file-workspace-message"><File aria-hidden="true" /><strong><Trans>Couldn’t preview {filename}</Trans></strong><span>{asset.error}</span>{asset.status === "error" && <button onClick={onRetry}><Trans>Try again</Trans></button>}</div>
          : <div className="file-workspace-message" role="status" aria-busy="true"><strong><Trans>Opening {filename}</Trans></strong><span><Trans>Reading file content…</Trans></span></div>}
    </div>
  </main>;
}

export function FileViewer({ asset, onClose }: {
  asset?: Extract<FileAssetSnapshot, { status: "ready" }>;
  onClose: () => void;
}) {
  useLingui();
  const titleId = useId();
  if (!asset) return null;
  const filename = collectionFileTitle(asset.file);
  return <Dialog className="file-viewer" titleId={titleId} onClose={onClose}>
    <h1 className="sr-only" id={titleId}><Trans>Preview {filename}</Trans></h1>
    <header><div><strong>{filename}</strong><span>{asset.file.path}</span></div><a href={asset.url} target="_blank" rel="noreferrer"><Trans>Open original</Trans></a><button className="icon-button" aria-label={t`Close file preview`} onClick={onClose} data-autofocus><X aria-hidden="true" /></button></header>
    <div className={`file-viewer-content file-viewer-${isReadOnlyMarkdownFile(asset.file) ? "markdown" : asset.file.mediaClass}`}><FileContent asset={asset} /></div>
  </Dialog>;
}

function FileContent({ asset }: { asset: Extract<FileAssetSnapshot, { status: "ready" }> }) {
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
  return <div className="file-workspace-message"><File aria-hidden="true" /><strong>{filename}</strong><span><Trans>{formatFileSize(asset.file.size)} · Preview unavailable. Use Open original to view this file.</Trans></span></div>;
}
