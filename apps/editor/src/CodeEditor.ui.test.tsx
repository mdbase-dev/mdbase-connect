import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeEditor } from "./CodeEditor";
import type { ResolvedFileReference } from "./use-file-assets";

vi.mock("./inline-pdf-viewer", () => ({
  mountInlinePdfViewer: vi.fn(() => ({ unmount: vi.fn() }))
}));

describe("rendered Markdown links", () => {
  it("opens a rendered link without moving the caret into its source", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CodeEditor
      value={"Start here.\nRead [the documentation](https://mdbase.dev/docs/)."}
      label="Note body"
      language="markdown"
      variant="writer"
    />);

    const link = await screen.findByRole("link", { name: "the documentation" });
    expect(fireEvent.mouseDown(link)).toBe(false);
    fireEvent.click(link);

    expect(open).toHaveBeenCalledWith("https://mdbase.dev/docs/", "_blank", "noopener,noreferrer");
    expect(screen.getByRole("link", { name: "the documentation" })).toBeInTheDocument();
  });
});

describe("PDF links and embeds", () => {
  it("focuses an embedded PDF in place without opening a modal", async () => {
    render(<CodeEditor
      value={"Intro.\n\n![[Documents/paper.pdf]]"}
      label="Note body"
      language="markdown"
      variant="writer"
      embeddedFiles={[pdfReference]}
    />);

    const open = await screen.findByRole("button", { name: "Open paper.pdf" });
    fireEvent.click(open);

    const viewer = await screen.findByRole("region", { name: "Embedded PDF, paper.pdf" });
    expect(viewer).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Preview paper.pdf" })).not.toBeInTheDocument();
  });

  it("opens a PDF wikilink in the file workspace", async () => {
    const openFile = vi.fn();
    render(<CodeEditor
      value={"Intro.\nRead [[Documents/paper.pdf]]."}
      label="Note body"
      language="markdown"
      variant="writer"
      files={[pdfReference.asset.file]}
      onOpenFileLink={openFile}
    />);

    fireEvent.click(await screen.findByRole("link", { name: "Documents/paper.pdf" }));
    expect(openFile).toHaveBeenCalledWith(pdfReference.asset.file);
  });
});

const pdfReference: ResolvedFileReference = {
  from: 8,
  to: 32,
  target: "Documents/paper.pdf",
  format: "wikilink",
  block: true,
  file: {
    fileId: "00000000-0000-4000-8000-000000000003",
    path: "Documents/paper.pdf",
    revision: "pdf-1",
    contentDigest: `sha256:${"3".repeat(64)}`,
    size: 10,
    mediaType: "application/pdf",
    mediaClass: "pdf",
    modifiedAt: "2026-08-09T00:00:00Z"
  },
  asset: {
    status: "ready",
    url: "blob:pdf",
    file: {
      fileId: "00000000-0000-4000-8000-000000000003",
      path: "Documents/paper.pdf",
      revision: "pdf-1",
      contentDigest: `sha256:${"3".repeat(64)}`,
      size: 10,
      mediaType: "application/pdf",
      mediaClass: "pdf",
      modifiedAt: "2026-08-09T00:00:00Z"
    }
  }
};
