import { render, screen } from "./test/locale";
import { describe, expect, it } from "vitest";
import { FileViewer, FileWorkspace } from "./FileViewer";
import type { CollectionFile } from "./model";

function upload(path: string, mediaClass: CollectionFile["mediaClass"], mediaType: string): CollectionFile {
  return {
    fileId: "00000000-0000-4000-8000-000000000001", path: `files/${path}`, revision: "r1",
    contentDigest: `sha256:${"a".repeat(64)}`, size: 4, mediaClass, mediaType, modifiedAt: ""
  };
}

describe("Open original", () => {
  it.each([
    ["photo.png", "image", "image/png"],
    ["scan.pdf", "pdf", "application/pdf"],
    ["clip.mp4", "video", "video/mp4"],
    ["notes.txt", "other", "text/plain"]
  ] as const)("opens inert %s in a new tab", (path, mediaClass, mediaType) => {
    const asset = { status: "ready", file: upload(path, mediaClass, mediaType), url: "blob:original" } as const;
    for (const element of [
      <FileWorkspace file={asset.file} asset={asset} onBack={() => {}} onRetry={() => {}} />,
      <FileViewer asset={asset} onClose={() => {}} />
    ]) {
      const view = render(element);
      const link = screen.getByRole("link", { name: "Open original" });
      expect(link).toHaveAttribute("href", "blob:original");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).not.toHaveAttribute("download");
      view.unmount();
    }
  });

  it.each([
    ["page.html", "other", "text/html"],
    ["drawing.svg", "image", "image/svg+xml"],
    ["data.json", "other", "application/json"]
  ] as const)("downloads %s instead of opening it at the editor origin", (path, mediaClass, mediaType) => {
    const asset = { status: "ready", file: upload(path, mediaClass, mediaType), url: "blob:original" } as const;
    for (const element of [
      <FileWorkspace file={asset.file} asset={asset} onBack={() => {}} onRetry={() => {}} />,
      <FileViewer asset={asset} onClose={() => {}} />
    ]) {
      const view = render(element);
      const link = screen.getByRole("link", { name: "Open original" });
      expect(link).toHaveAttribute("href", "blob:original");
      expect(link).toHaveAttribute("download", path);
      expect(link).not.toHaveAttribute("target");
      view.unmount();
    }
  });

  it("keeps the inline SVG image preview", () => {
    const asset = { status: "ready", file: upload("drawing.svg", "image", "image/svg+xml"), url: "blob:original" } as const;
    render(<FileViewer asset={asset} onClose={() => {}} />);
    expect(screen.getByRole("img", { name: "drawing.svg" })).toHaveAttribute("src", "blob:original");
  });
});
