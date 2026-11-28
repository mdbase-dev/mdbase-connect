import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRoot, type Root } from "react-dom/client";
import { EmbedPdfViewer } from "./EmbedPdfViewer";

export function mountInlinePdfViewer(container: HTMLElement, src: string, filename: string): Root {
  const root = createRoot(container);
  root.render(<I18nProvider i18n={i18n}><EmbedPdfViewer src={src} filename={filename} /></I18nProvider>);
  return root;
}
