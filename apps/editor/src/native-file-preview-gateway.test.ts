import { act, renderHook, waitFor } from "@testing-library/react";
import { MdbaseError, type FilesApi, type FileView } from "@mdbase-dev/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileAssetStore } from "./file-asset-store";
import { fileAssetKey } from "./file-reference-resolution";
import type { CollectionFile } from "./model";
import { NativeEditorGateway } from "./native-gateway";
import { closeNativeFixtures, readyFixture } from "./test/native-fixture";
import { useFileWorkspace } from "./use-file-workspace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const gateways: NativeEditorGateway[] = [];
beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:verified");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.dispose();
  closeNativeFixtures();
  vi.restoreAllMocks();
});

// Real borrowed SDK connection, with controlled public FilesApi responses.
// These controls prove Editor integration, NOT SDK/native cleanup or integrity.
async function fixture(overrides: Partial<FileView> = {}) {
  const f = await readyFixture();
  const file: FileView = {
    id: "00000000-0000-4000-8000-000000000001", path: "sources/large.md",
    digest: `sha256:${"a".repeat(64)}`, size: 2, confirmedSeq: 7,
    contentProfile: "unindexed_markdown_blob", media: "other", mediaType: "text/markdown",
    state: "materialized", ...overrides
  };
  const metadata = deferred<FileView>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream: ReturnType<FilesApi["downloadStream"]> = Object.assign(new ReadableStream<Uint8Array>({
    start(value) { controller = value; }
  }), { file: metadata.promise });
  const reader = stream.getReader();
  const cancel = vi.spyOn(reader, "cancel");
  const release = vi.spyOn(reader, "releaseLock");
  const read = vi.spyOn(reader, "read");
  vi.spyOn(stream, "getReader").mockReturnValue(reader);
  const list = vi.spyOn(f.client.files, "listPage").mockResolvedValue({ files: [file], complete: true });
  // The legacy path would succeed immediately, exposing bypass of the barrier.
  const get = vi.spyOn(f.client.files, "get").mockResolvedValue(file);
  const download = vi.spyOn(f.client.files, "download").mockResolvedValue(new Uint8Array([104, 105]));
  const downloadStream = vi.spyOn(f.client.files, "downloadStream").mockReturnValue(stream);
  const close = vi.spyOn(f.client, "close");
  const gateway = new NativeEditorGateway(f.application, f.connection);
  gateways.push(gateway);
  const selected = (await gateway.listFiles())[0]!;
  return { ...f, file, metadata, controller, stream, cancel, release, read, list, get, download, downloadStream, close, gateway, selected };
}

const cancelled = (pending: Promise<unknown>) => expect(pending).rejects.toMatchObject({ code: "cancelled", recovery: "none" });

describe("native file preview gateway public-interface controls", () => {
  it.each(["unindexed_markdown_blob", "unindexed_markdown_attachment_v1", "ordinary_blob", undefined] as const)(
    "preserves inventory metadata without inferring profile: %s", async contentProfile => {
      const f = await fixture({ contentProfile });
      expect(f.selected).toMatchObject({ confirmedSeq: 7, mediaType: "text/markdown" });
      expect(f.selected.contentProfile).toBe(contentProfile);
      expect(f.selected.revision).toBe(f.file.digest);
    }
  );

  it("uses only a pinned full public stream and waits for successful completion", async () => {
    const f = await fixture();
    const progress = vi.fn();
    const published = vi.fn();
    const pending = f.gateway.readFile(f.selected, { onProgress: progress }).then(blob => { published(blob); return blob; });
    void pending.catch(() => {});
    expect(f.downloadStream).toHaveBeenCalledTimes(1);
    const [id, options] = f.downloadStream.mock.calls[0]!;
    expect(id).toBe(f.file.id);
    expect(options).toMatchObject({ revision: f.file.digest, signal: expect.any(AbortSignal) });
    expect(options).not.toHaveProperty("range");
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([104, 105]));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    expect(published).not.toHaveBeenCalled();
    options!.onProgress?.({ id: 1, phase: "streaming", done: 2, total: 2 });
    expect(progress).toHaveBeenCalledWith({ phase: "downloading", transferredBytes: 2, totalBytes: 2 });
    f.controller.close();
    expect(await (await pending).text()).toBe("hi");
    expect(f.get).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
    f.gateway.dispose();
    expect(f.close).not.toHaveBeenCalled();
  });

  it.each([{ path: "moved.md" }, { confirmedSeq: 8 }, { contentProfile: "ordinary_blob" as const }, { size: 3 }])(
    "never adopts freshly returned different metadata: %j", async change => {
      const f = await fixture();
      const pending = f.gateway.readFile(f.selected);
      void pending.catch(() => {});
      expect(f.downloadStream).toHaveBeenCalledTimes(1);
      f.metadata.resolve({ ...f.file, ...change });
      await expect(pending).rejects.toThrow("changed");
      expect(f.read).not.toHaveBeenCalled();
      expect(f.get).not.toHaveBeenCalled();
      expect(f.download).not.toHaveBeenCalled();
      expect(f.cancel).toHaveBeenCalledTimes(1);
    }
  );

  it("does not promote an unknown selection using a fresh get", async () => {
    const f = await fixture({ contentProfile: undefined });
    f.get.mockResolvedValue({ ...f.file, contentProfile: "unindexed_markdown_blob" });
    const pending = f.gateway.readFile(f.selected);
    void pending.catch(() => {});
    expect(f.downloadStream).toHaveBeenCalledTimes(1);
    f.metadata.resolve({ ...f.file, contentProfile: "unindexed_markdown_blob" });
    await expect(pending).rejects.toThrow("changed");
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each(["caller", "dispose", "timeout"] as const)("aborts owned reads on %s without closing the borrowed client", async cause => {
    const f = await fixture();
    const caller = new AbortController();
    const timeout = new AbortController();
    if (cause === "timeout") vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const pending = f.gateway.readFile(f.selected, { signal: caller.signal });
    void pending.catch(() => {});
    expect(f.downloadStream).toHaveBeenCalledTimes(1);
    const signal = f.downloadStream.mock.calls[0]![1]!.signal!;
    if (cause === "caller") caller.abort();
    else if (cause === "dispose") f.gateway.dispose();
    else timeout.abort();
    expect(signal.aborted).toBe(true);
    await cancelled(pending);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.stream.locked).toBe(true);
    f.metadata.resolve(f.file);
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.stream.locked).toBe(false);
  });

  it.each(["scope", "selection"] as const)("fences %s change at a pending settlement", async cause => {
    const f = await fixture();
    const pending = f.gateway.readFile(f.selected);
    void pending.catch(() => {});
    expect(f.downloadStream).toHaveBeenCalledTimes(1);
    f.metadata.resolve(f.file);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalled());
    if (cause === "scope") f.current.mockReturnValue(false);
    else f.selected.confirmedSeq = 8;
    f.controller.enqueue(new Uint8Array([104, 105]));
    f.controller.close();
    await cancelled(pending);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates Hosted unavailable/recovery-none without fallback or retry", async () => {
    const f = await fixture();
    const failure = new MdbaseError({ code: "unavailable", recovery: "none", message: "Hosted file unavailable" });
    const pending = f.gateway.readFile(f.selected);
    void pending.catch(() => {});
    expect(f.downloadStream).toHaveBeenCalledTimes(1);
    f.metadata.reject(failure);
    await expect(pending).rejects.toBe(failure);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.downloadStream).toHaveBeenCalledTimes(1);
  });

  it("refuses oversized selections before any file I/O", async () => {
    const f = await fixture({ size: 64 * 1024 * 1024 + 1 });
    await expect(f.gateway.readFile(f.selected)).rejects.toMatchObject({ code: "too_large" });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.downloadStream).not.toHaveBeenCalled();
  });

  it("preserves ordinary binary media bytes", async () => {
    const f = await fixture({ path: "image.png", media: "image", mediaType: "image/png", contentProfile: "ordinary_attachment_v1" });
    const pending = f.gateway.readFile(f.selected);
    void pending.catch(() => {});
    expect(f.downloadStream).toHaveBeenCalledTimes(1);
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([0xff, 0x00]));
    f.controller.close();
    expect(new Uint8Array(await (await pending).arrayBuffer())).toEqual(new Uint8Array([0xff, 0x00]));
  });
});

const descriptor: CollectionFile = {
  fileId: "one", path: "source.md", revision: "sha256:one", contentDigest: "sha256:one", size: 2,
  mediaClass: "other", modifiedAt: "", contentProfile: "unindexed_markdown_blob", confirmedSeq: 7
};

describe("workspace actual-inventory currency controls", () => {
  it.each([
    { contentProfile: "unindexed_markdown_attachment_v1" as const }, { confirmedSeq: 8 },
    { size: 3 }, { path: "moved.md" }, { mediaType: "text/plain" }, { modifiedAt: "new" }
  ])("releases old loading selections on metadata-only inventory change: %j", async change => {
    const pending: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred<Blob>> }> = [];
    const store = new FileAssetStore({ readFile: vi.fn((_file, options) => {
      const result = deferred<Blob>();
      pending.push({ signal: options!.signal!, result });
      return result.promise;
    }) });
    const hook = renderHook(({ files }) => useFileWorkspace(store, files, ""), { initialProps: { files: [descriptor] } });
    act(() => hook.result.current.setSelectedFile(descriptor));
    expect(pending).toHaveLength(1);
    const replacement = { ...descriptor, ...change };
    expect(fileAssetKey(replacement)).not.toBe(fileAssetKey(descriptor));
    hook.rerender({ files: [replacement] });
    expect(hook.result.current.selectedFile).toEqual(replacement);
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending).toHaveLength(2);
    await act(async () => { pending[0].result.reject(new Error("stale error")); });
    expect(hook.result.current.selectedAsset?.status).toBe("loading");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await act(async () => { pending[1].result.resolve(new Blob(["new"])); });
    expect(hook.result.current.selectedAsset?.status).toBe("ready");
    hook.unmount();
    store.reset();
  });

  it("does not bind a selected file or open URL to a replacement account/collection store", async () => {
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob(["old"])) });
    const replacementRead = vi.fn().mockResolvedValue(new Blob(["new"]));
    const replacement = new FileAssetStore({ readFile: replacementRead });
    const hook = renderHook(({ store }) => useFileWorkspace(store, [descriptor], ""), { initialProps: { store } });
    act(() => hook.result.current.setSelectedFile(descriptor));
    await waitFor(() => expect(hook.result.current.selectedAsset?.status).toBe("ready"));
    act(() => {
      const asset = hook.result.current.selectedAsset!;
      if (asset.status === "ready") hook.result.current.setOpenAsset(asset);
    });
    expect(hook.result.current.openAsset?.status).toBe("ready");
    hook.rerender({ store: replacement });
    expect(hook.result.current.selectedFile).toBeUndefined();
    expect(hook.result.current.selectedAsset).toBeUndefined();
    expect(hook.result.current.openAsset).toBeUndefined();
    expect(replacementRead).not.toHaveBeenCalled();
    hook.unmount();
    store.reset();
    replacement.reset();
  });

  it.each(["metadata", "reset", "remove"] as const)("retires an already open payload after %s", async cause => {
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob(["old"])) });
    const hook = renderHook(({ files }) => useFileWorkspace(store, files, ""), { initialProps: { files: [descriptor] } });
    act(() => hook.result.current.setSelectedFile(descriptor));
    await waitFor(() => expect(hook.result.current.selectedAsset?.status).toBe("ready"));
    act(() => {
      const asset = hook.result.current.selectedAsset!;
      if (asset.status === "ready") hook.result.current.setOpenAsset(asset);
    });
    expect(hook.result.current.openAsset?.status).toBe("ready");
    if (cause === "reset") act(() => store.reset());
    else hook.rerender({ files: cause === "remove" ? [] : [{ ...descriptor, confirmedSeq: 8 }] });
    expect(hook.result.current.openAsset).toBeUndefined();
    hook.unmount();
    store.reset();
  });
});
