import { render } from "./test/locale";
import { describe, expect, it, vi } from "vitest";
import { EmbedPdfViewer } from "./EmbedPdfViewer";

const { pdfViewer } = vi.hoisted(() => ({ pdfViewer: vi.fn(() => null) }));

vi.mock("@embedpdf/react-pdf-viewer", () => ({ PDFViewer: pdfViewer }));
vi.mock("@embedpdf/pdfium/pdfium.wasm?url", () => ({ default: "/assets/pdfium-local.wasm" }));

describe("EmbedPdfViewer", () => {
  it("uses local viewer assets without loading EmbedPDF defaults from a CDN", () => {
    render(<EmbedPdfViewer src="blob:document" filename="paper.pdf" />);

    expect(pdfViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          src: "blob:document",
          wasmUrl: new URL("/assets/pdfium-local.wasm", globalThis.location.href).href,
          fonts: {
            ui: {
              family: '"Atkinson Hyperlegible", system-ui, sans-serif',
              stylesheetUrl: null
            },
            signature: null
          },
          stamp: { defaultLibrary: false }
        })
      }),
      undefined
    );
  });
});
