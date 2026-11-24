import { fireEvent, render, screen } from "./test/locale";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditor } from "./CodeEditor";
import { FileViewer, FileWorkspace } from "./FileViewer";
import { FileAssetStore } from "./file-asset-store";
import { HTML_IFRAME_SANDBOX, MAX_HTML_PREVIEW_BYTES, MAX_HTML_SOURCE_CHARACTERS } from "./html-preview";
import type { CollectionFile } from "./model";
import { useFileAsset, type ResolvedFileReference } from "./use-file-assets";

function htmlFile(source: string, overrides: Partial<CollectionFile> = {}): CollectionFile {
  return {
    fileId: "00000000-0000-4000-8000-000000000010",
    path: "files/reader/discord.com.readable.html",
    revision: "r1",
    contentDigest: `sha256:${"b".repeat(64)}`,
    size: new TextEncoder().encode(source).byteLength,
    mediaClass: "other",
    mediaType: "text/html",
    modifiedAt: "",
    ...overrides
  };
}

function ViewerHarness({ store, selected, modal = false }: {
  store: FileAssetStore;
  selected: CollectionFile;
  modal?: boolean;
}) {
  const asset = useFileAsset(store, selected)!;
  return modal
    ? <FileViewer asset={asset.status === "ready" ? asset : undefined} onClose={() => {}} />
    : <FileWorkspace file={selected} asset={asset} onBack={() => {}} onRetry={() => void store.retry(selected)} />;
}

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:html-original");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

describe("sandboxed HTML preview in FileWorkspace and FileViewer", () => {
  it.each([false, true])("renders sandboxed srcdoc iframe, toggles to source, and keeps Open original as download (modal=%s)", async (modal) => {
    const source = '<!doctype html><html><body><h1>Saved page</h1><script>alert(1)</script><a href="https://example.com">Link</a><a href="javascript:alert(2)">Bad</a></body></html>';
    const selected = htmlFile(source);
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob([source], { type: "text/html" })) });
    const view = render(<ViewerHarness store={store} selected={selected} modal={modal} />);

    const frame = await screen.findByTitle("HTML preview, discord.com.readable.html");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", HTML_IFRAME_SANDBOX);
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).not.toHaveAttribute("src");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("<h1>Saved page</h1>");
    expect(srcdoc).not.toContain("<script>");
    expect(srcdoc).toContain('target="_blank"');
    expect(srcdoc).toContain('rel="noopener noreferrer"');
    expect(srcdoc).not.toContain("javascript:");

    // Open original stays an opaque download of the verified original bytes.
    const link = screen.getByRole("link", { name: "Open original" });
    expect(link).toHaveAttribute("href", "blob:html-original");
    expect(link).toHaveAttribute("download", "discord.com.readable.html");
    expect(link).not.toHaveAttribute("target");
    const original = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(original.type).toBe("application/octet-stream");
    expect(await original.text()).toBe(source);

    // Toggle to Source and back to Preview.
    const previewButton = screen.getByRole("button", { name: "Preview" });
    const sourceButton = screen.getByRole("button", { name: "Source" });
    expect(previewButton).toHaveAttribute("aria-pressed", "true");
    expect(sourceButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(sourceButton);
    expect(sourceButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTitle("HTML preview, discord.com.readable.html")).not.toBeInTheDocument();
    const sourceRegion = screen.getByRole("region", { name: "HTML source, discord.com.readable.html" });
    expect(sourceRegion).toHaveTextContent("<script>alert(1)</script>");

    fireEvent.click(previewButton);
    expect(screen.getByTitle("HTML preview, discord.com.readable.html")).toBeInTheDocument();

    view.unmount();
    store.reset();
  });

  it("resets back to Preview when switching to another HTML file", async () => {
    const first = htmlFile("<p>First</p>", { fileId: "00000000-0000-4000-8000-000000000011", path: "files/first.html" });
    const second = htmlFile("<p>Second</p>", { fileId: "00000000-0000-4000-8000-000000000012", path: "files/second.html" });
    const store = new FileAssetStore({
      readFile: vi.fn(async (file) => new Blob([file.path === first.path ? "<p>First</p>" : "<p>Second</p>"]))
    });
    const view = render(<ViewerHarness store={store} selected={first} />);

    await screen.findByTitle("HTML preview, first.html");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByRole("region", { name: "HTML source, first.html" })).toBeInTheDocument();

    view.rerender(<ViewerHarness store={store} selected={second} />);
    expect(await screen.findByTitle("HTML preview, second.html")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");

    view.unmount();
    store.reset();
  });

  it("skips inline preview for oversized HTML files while keeping Open original downloadable", async () => {
    const selected = htmlFile("", { size: MAX_HTML_PREVIEW_BYTES + 1, path: "files/huge.archive.html" });
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob(["<html></html>"])) });
    const view = render(<ViewerHarness store={store} selected={selected} />);

    expect(await screen.findByText(/HTML preview is limited to/)).toBeInTheDocument();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("button", { name: "Source" })).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open original" });
    expect(link).toHaveAttribute("download", "huge.archive.html");

    view.unmount();
    store.reset();
  });

  it("truncates oversized HTML source display with a notice pointing to Open original", async () => {
    const source = "<p>" + "x".repeat(MAX_HTML_SOURCE_CHARACTERS + 64) + "</p>";
    const selected = htmlFile(source, { path: "files/long.html" });
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob([source])) });
    const view = render(<ViewerHarness store={store} selected={selected} />);

    await screen.findByTitle("HTML preview, long.html");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText(/Preview truncated for display/)).toBeInTheDocument();

    view.unmount();
    store.reset();
  });

  it("renders inline HTML embeds in CodeEditor inside a sandboxed srcdoc iframe", async () => {
    const source = "<html><body><h1>Embedded</h1><script>alert(1)</script></body></html>";
    const file = htmlFile(source, { path: "files/embed.html" });
    const value = "Intro.\n\n![[files/embed.html]]";
    const reference: ResolvedFileReference = {
      from: 8,
      to: 29,
      raw: "![[files/embed.html]]",
      target: "files/embed.html",
      format: "wikilink",
      block: true,
      file,
      asset: { status: "ready", file, url: "blob:html-original", sourceText: source }
    };
    render(<CodeEditor
      value={value}
      label="Note body"
      language="markdown"
      variant="writer"
      embeddedFiles={{ source: value, references: [reference] }}
    />);

    const frame = await screen.findByTitle("HTML preview, embed.html");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", HTML_IFRAME_SANDBOX);
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Embedded</h1>");
    expect(frame.getAttribute("srcdoc")).not.toContain("<script>");
  });
});
