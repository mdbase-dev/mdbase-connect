import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileViewer, FileWorkspace } from "./FileViewer";
import { FileAssetStore } from "./file-asset-store";
import { useFileAsset } from "./use-file-assets";
import { downloadNativeFile } from "./native-file-download";
import type { FileView } from "@mdbase-dev/sdk";
import type { CollectionFile } from "./model";

const profiles = ["unindexed_markdown_blob", "unindexed_markdown_attachment_v1"] as const;
function file(source: string, contentProfile: CollectionFile["contentProfile"] = profiles[0]): CollectionFile {
  return {
    fileId: "00000000-0000-4000-8000-000000000001", path: "original.md", revision: "r1", contentDigest: `sha256:${"a".repeat(64)}`,
    size: new TextEncoder().encode(source).byteLength, contentProfile,
    mediaClass: "other", mediaType: "text/markdown", modifiedAt: ""
  };
}
function Preview({ store, selected, modal = false }: { store: FileAssetStore; selected: CollectionFile; modal?: boolean }) {
  const asset = useFileAsset(store, selected)!;
  return modal ? <FileViewer asset={asset.status === "ready" ? asset : undefined} onClose={() => {}} />
    : <FileWorkspace file={selected} asset={asset} onBack={() => {}} onRetry={() => void store.retry(selected)} />;
}

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:verified");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

describe("verified inert Markdown in both production viewers", () => {
  it.each(profiles.flatMap(profile => [false, true].flatMap(modal =>
    (["image", "pdf", "audio", "video"] as const).map(mediaClass => ({ profile, modal, mediaClass }))))) (
    "renders only the exact $profile profile (modal=$modal), ahead of contradictory $mediaClass", async ({ profile, modal, mediaClass }) => {
      const source = "# A heading\n\nA **strong** and *emphasized* paragraph.\n\n> A quote\n\n- First\n- Second\n\n```js\nconst safe = true;\n```";
      const selected = { ...file(source, profile), mediaClass };
      const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob([source], { type: "text/html" })) });
      const view = render(<Preview store={store} selected={selected} modal={modal} />);
      const preview = await screen.findByRole("region", { name: "Read-only Markdown preview" });
      expect(within(preview).getByRole("heading", { name: "A heading", level: 1 })).toBeInTheDocument();
      expect(preview.querySelector("strong")).toHaveTextContent("strong");
      expect(preview.querySelector("em")).toHaveTextContent("emphasized");
      expect(preview.querySelector("blockquote")).toHaveTextContent("A quote");
      expect(within(preview).getAllByRole("listitem")).toHaveLength(2);
      expect(preview.querySelector("pre code")).toHaveTextContent("const safe = true;");
      expect(view.container.querySelector("video,audio,img,iframe,object,embed,.cm-editor,[contenteditable],textarea")).toBeNull();
      expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute("href", "blob:verified");
      const original = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
      expect(original.type).toBe("text/plain;charset=utf-8");
      expect(Array.from(new Uint8Array(await original.arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode(source)));
      view.unmount();
      store.reset();
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    }
  );

  it("fails closed instead of instantiating media when a Markdown ready asset lacks verified text", () => {
    const selected = { ...file(""), mediaClass: "image" as const };
    const view = render(<FileViewer asset={{ status: "ready", file: selected, url: "blob:not-text" }} onClose={() => {}} />);
    expect(screen.getByText("Markdown preview unavailable.")).toBeInTheDocument();
    expect(view.container.querySelector("img,iframe,video,audio,.cm-editor,[contenteditable]")).toBeNull();
    expect(screen.queryByRole("region", { name: "Read-only Markdown preview" })).not.toBeInTheDocument();
  });

  it.each([undefined, "ordinary_blob", "future_markdown", "unindexed_markdown_blob "])(
    "never infers Markdown from .md or MIME for profile %s", async profile => {
      const source = "# Not a note";
      const selected = { ...file(source), contentProfile: profile } as CollectionFile;
      const blob = new Blob([source], { type: "text/markdown" });
      const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(blob) });
      render(<Preview store={store} selected={selected} />);
      expect(await screen.findByText(/Preview unavailable/)).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Read-only Markdown preview" })).not.toBeInTheDocument();
      expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
      expect(store.get(selected)).not.toHaveProperty("sourceText");
    }
  );

  it("escapes raw HTML and keeps schemes, remote images, wiki embeds and tasks inert through drop/paste/click", async () => {
    const source = '# Safe\n\n<script>alert(1)</script>\n\n<iframe src="https://attacker.invalid"></iframe>\n\n<img src=x onerror="alert(1)">\n\n[javascript](javascript:alert(1)) [data](data:text/html,bad) [remote](https://attacker.invalid)\n\n![image](https://attacker.invalid/a.png) ![data](data:image/svg+xml,bad)\n\n[[Missing note]] ![[file.pdf]]\n\n- [ ] Pending\n- [x] Done';
    // Extra mutators deliberately supplied at the source boundary: none may be called.
    const sourceApi = { readFile: vi.fn().mockResolvedValue(new Blob([source])), updateNote: vi.fn(), createNote: vi.fn(), uploadFile: vi.fn(), save: vi.fn() };
    const store = new FileAssetStore(sourceApi);
    const selected = file(source);
    const view = render(<Preview store={store} selected={selected} />);
    const preview = await screen.findByRole("region", { name: "Read-only Markdown preview" });
    const before = preview.innerHTML;
    expect(preview).toHaveTextContent('<script>alert(1)</script>');
    expect(preview).toHaveTextContent('[[Missing note]] ![[file.pdf]]');
    expect(preview).toHaveTextContent('[javascript](javascript:alert(1))');
    expect(preview).toHaveTextContent('[data](data:text/html,bad)');
    expect(preview).toHaveTextContent('![image](https://attacker.invalid/a.png)');
    expect(preview.querySelector("script,iframe,img,video,audio,object,embed,a,[href],[src],[contenteditable],textarea,.cm-editor")).toBeNull();
    for (const checkbox of preview.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      expect(checkbox.disabled).toBe(true);
      expect(checkbox.readOnly).toBe(true);
      fireEvent.click(checkbox);
    }
    fireEvent.drop(preview, { dataTransfer: { files: [new File(["bad"], "bad.md")], getData: () => "bad" } });
    fireEvent.paste(preview, { clipboardData: { getData: () => "injected" } });
    fireEvent.input(preview, { data: "injected" });
    fireEvent.click(preview);
    expect(preview.innerHTML).toBe(before);
    expect(sourceApi.updateNote).not.toHaveBeenCalled();
    expect(sourceApi.createNote).not.toHaveBeenCalled();
    expect(sourceApi.uploadFile).not.toHaveBeenCalled();
    expect(sourceApi.save).not.toHaveBeenCalled();
    expect(store.get(selected)).toMatchObject({ status: "ready", sourceText: source });
    view.unmount();
    store.reset();
  });

  it.each([1048576, 1048578])("uses full UTF8 bytes, not character count, at the launch limit: %s", async bytes => {
    const source = "é".repeat(bytes / 2);
    const selected = file(source);
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob([source])) });
    const view = render(<Preview store={store} selected={selected} />);
    const preview = await screen.findByRole("region", { name: "Read-only Markdown preview" });
    expect(Boolean(screen.queryByText("Notes larger than 1 MiB are read-only at launch."))).toBe(bytes > 1048576);
    expect(preview).toHaveTextContent(/Preview truncated/);
    expect(preview.querySelectorAll("*").length).toBeLessThan(2100);
    expect(store.get(selected)).toMatchObject({ sourceText: source });
    const original = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(original.size).toBe(bytes);
    expect(await original.text()).toBe(source);
    view.unmount();
    store.reset();
  });

  it("bounds pathological many-node/nested Markdown and keeps the whole original", async () => {
    const source = "> ".repeat(100) + "deep\n\n" + "*a* ".repeat(10000);
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob([source])) });
    const selected = file(source);
    render(<Preview store={store} selected={selected} />);
    const preview = await screen.findByRole("region", { name: "Read-only Markdown preview" });
    expect(preview.querySelectorAll("*").length).toBeLessThan(2100);
    expect(preview).toHaveTextContent(/Preview truncated/);
    expect(store.get(selected)).toMatchObject({ sourceText: source });
  });

  it("never renders provisional or stale source; shows decode and download failures without a URL", async () => {
    let resolve!: (blob: Blob) => void;
    const readFile = vi.fn().mockImplementationOnce(() => new Promise<Blob>(yes => { resolve = yes; }))
      .mockResolvedValueOnce(new Blob([new Uint8Array([0xc3, 0x28])]))
      .mockRejectedValueOnce(new Error("whole-stream verification failed"));
    const store = new FileAssetStore({ readFile });
    const old = file("# Old");
    const current = { ...old, revision: "r2" };
    const view = render(<Preview store={store} selected={old} />);
    expect(screen.queryByRole("region", { name: "Read-only Markdown preview" })).not.toBeInTheDocument();
    view.rerender(<Preview store={store} selected={current} />);
    await screen.findByText(/Couldn’t preview/);
    await act(async () => { resolve(new Blob(["# Old"])); });
    expect(store.get(old).status).toBe("idle");
    expect(store.get(current).status).toBe("error");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("whole-stream verification failed");
    expect(screen.queryByRole("region", { name: "Read-only Markdown preview" })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["complete", "partial failure"] as const)("does not render streamed Markdown before metadata and successful EOF: %s", async outcome => {
    const source = "# Verified EOF";
    const selected = file(source);
    const metadata: FileView = {
      id: selected.fileId, path: selected.path, size: selected.size, confirmedSeq: 7,
      digest: `sha256:${"a".repeat(64)}`, contentProfile: "unindexed_markdown_blob",
      media: "other", mediaType: "text/html", state: "materialized"
    };
    let resolveMetadata!: (value: FileView) => void;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = Object.assign(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), {
      file: new Promise<FileView>(yes => { resolveMetadata = yes; })
    });
    const store = new FileAssetStore({ readFile: (_file, options) => downloadNativeFile({ downloadStream: () => stream }, metadata, {
      signal: options!.signal!, isCurrent: () => !options!.signal!.aborted
    }).then(bytes => new Blob([bytes as BlobPart], { type: "text/html" })) });
    const view = render(<Preview store={store} selected={selected} />);
    await act(async () => { controller.enqueue(new TextEncoder().encode(source)); });
    expect(store.get(selected).status).toBe("loading");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Read-only Markdown preview" })).not.toBeInTheDocument();
    await act(async () => { resolveMetadata(metadata); });
    expect(store.get(selected).status).toBe("loading");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "complete") controller.close();
      else controller.error(new Error("partial source failure"));
    });
    if (outcome === "complete") {
      expect(await screen.findByRole("heading", { name: "Verified EOF" })).toBeInTheDocument();
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    } else {
      expect(await screen.findByText(/Couldn’t preview/)).toBeInTheDocument();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(store.get(selected)).not.toHaveProperty("sourceText");
      expect(screen.queryByRole("region", { name: "Read-only Markdown preview" })).not.toBeInTheDocument();
    }
    view.unmount();
    store.reset();
  });

  it("preserves the ordinary image path without Markdown decoding or MIME rewriting", async () => {
    const selected = { ...file("png", "ordinary_blob"), path: "image.png", mediaClass: "image" as const };
    const blob = new Blob([new Uint8Array([0xff])], { type: "image/png" });
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(blob) });
    render(<Preview store={store} selected={selected} />);
    expect(await screen.findByRole("img", { name: "image.png" })).toHaveAttribute("src", "blob:verified");
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  });
});
