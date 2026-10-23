import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { PDFViewer } from "@embedpdf/react-pdf-viewer";
import pdfiumWasmAssetPath from "@embedpdf/pdfium/pdfium.wasm?url";

const pdfiumWasmUrl = new URL(pdfiumWasmAssetPath, globalThis.location.href).href;

export function EmbedPdfViewer({ src, filename }: { src: string; filename: string }) {
  useLingui();
  return (
    <div className="embedpdf-viewer" aria-label={t`PDF viewer, ${filename}`}>
      <PDFViewer
        config={{
          src,
          wasmUrl: pdfiumWasmUrl,
          tabBar: "never",
          theme: { preference: "system" },
          fonts: {
            ui: {
              family: '"Atkinson Hyperlegible", system-ui, sans-serif',
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
      />
    </div>
  );
}
