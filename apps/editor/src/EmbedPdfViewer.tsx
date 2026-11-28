import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { PDFViewer, type DocumentManagerPlugin, type PluginRegistry } from "@embedpdf/react-pdf-viewer";
import { useEffect, useRef, useState } from "react";
import pdfiumWasmAssetPath from "@embedpdf/pdfium/pdfium.wasm?url";

const pdfiumWasmUrl = new URL(pdfiumWasmAssetPath, globalThis.location.href).href;

export function EmbedPdfViewer({ src, filename }: { src: string; filename: string }) {
  // The embedded viewer reads its configuration only when it mounts.
  return <PdfPreview key={src} src={src} filename={filename} />;
}

function PdfPreview({ src, filename }: { src: string; filename: string }) {
  useLingui();
  const [preview, setPreview] = useState<"opening" | "ready" | "failed">("opening");
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (preview !== "opening") return;
    // The registry can be ready while the PDF worker or WASM is still
    // initializing. A failed worker can leave document loading unsettled.
    const timer = setTimeout(() => setPreview("failed"), 20_000);
    return () => {
      clearTimeout(timer);
      unsubscribe.current?.();
      unsubscribe.current = undefined;
    };
  }, [preview]);

  function watchDocument(registry: PluginRegistry) {
    const manager = registry.getPlugin<DocumentManagerPlugin>("document-manager")?.provides();
    if (!manager) return;
    // Show EmbedPDF's own error or password prompt once it has a document result.
    const ready = () => setPreview("ready");
    const opened = manager.onDocumentOpened(ready);
    const failed = manager.onDocumentError(ready);
    unsubscribe.current = () => { opened(); failed(); };
    if (manager.getOpenDocuments().some(document => document.status !== "loading")) ready();
  }
  return (
    <div className="embedpdf-viewer" role="region" aria-label={t`PDF viewer, ${filename}`}>
      {preview === "opening" && <div className="file-workspace-message" role="status"><strong><Trans>Opening {filename}</Trans></strong></div>}
      {preview === "failed" ? <div className="file-workspace-message">
        <strong role="alert"><Trans>Couldn’t preview {filename}</Trans></strong>
        <button type="button" onClick={() => setPreview("opening")}><Trans>Try again</Trans></button>
      </div> : <PDFViewer
        className={preview === "opening" ? "embedpdf-initializing" : undefined}
        onReady={watchDocument}
        config={{
          wasmUrl: pdfiumWasmUrl,
          documentManager: { initialDocuments: [{ url: src, name: filename }] },
          tabBar: "never",
          theme: { preference: "system" },
          fonts: {
            ui: {
              family: '"IBM Plex Sans", system-ui, sans-serif',
              stylesheetUrl: null
            },
            signature: null
          },
          stamp: { defaultLibrary: false },
          disabledCategories: [
            "annotation",
            "form",
            "redaction",
            "insert",
            "history",
            "document-open",
            "document-close"
          ]
        }}
        style={{ width: "100%", height: "100%" }}
      />}
    </div>
  );
}
