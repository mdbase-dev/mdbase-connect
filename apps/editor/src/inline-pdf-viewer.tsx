import { createRoot, type Root } from "react-dom/client";
import { EmbedPdfViewer } from "./EmbedPdfViewer";

export function mountInlinePdfViewer(container: HTMLElement, src: string, filename: string): Root {
  const root = createRoot(container);
  root.render(<EmbedPdfViewer src={src} filename={filename} />);
  return root;
}
