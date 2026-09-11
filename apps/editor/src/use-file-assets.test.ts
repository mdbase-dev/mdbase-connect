import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileAssetStore } from "./file-asset-store";
import type { CollectionFile } from "./model";
import { useEmbeddedFileAssets } from "./use-file-assets";

const file: CollectionFile = {
  fileId: "image", path: "image.png", revision: "1", contentDigest: "sha256:image",
  size: 10, mediaType: "image/png", mediaClass: "image", modifiedAt: ""
};
const files = [file];
const hidden = new Set<string>();

describe("embedded file asset identity", () => {
  it("publishes async acquired assets and invalidates on store replacement", async () => {
    const createURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ready");
    const revokeURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let resolve!: (blob: Blob) => void;
    const readFile = vi.fn(() => new Promise<Blob>((done) => { resolve = done; }));
    const store = new FileAssetStore({ readFile });
    const hook = renderHook(({ store }) => useEmbeddedFileAssets(store, "![[image.png]]", files), { initialProps: { store } });
    await waitFor(() => expect(hook.result.current[0]?.asset.status).toBe("loading"));
    const loading = hook.result.current;
    hook.rerender({ store });
    expect(hook.result.current).toBe(loading);
    expect(readFile).toHaveBeenCalledTimes(1);
    await act(async () => resolve(new Blob(["image"])));
    expect(hook.result.current).not.toBe(loading);
    expect(hook.result.current[0].asset).toMatchObject({ status: "ready", url: "blob:ready" });
    const ready = hook.result.current;
    hook.rerender({ store });
    expect(hook.result.current).toBe(ready);
    const replacement = new FileAssetStore({ readFile: vi.fn(async () => { throw new Error("new collection"); }) });
    hook.rerender({ store: replacement });
    await waitFor(() => expect(hook.result.current[0]?.asset).toMatchObject({ status: "error", error: "new collection" }));
    expect(hook.result.current).not.toBe(ready);
    hook.unmount();
    store.reset();
    replacement.reset();
    createURL.mockRestore();
    revokeURL.mockRestore();
  });

  it("retains arrays on unchanged renders but publishes asset versions and store resets", async () => {
    const readFile = vi.fn(async () => { throw new Error("asset failed"); });
    const store = new FileAssetStore({ readFile });
    const hook = renderHook(() => useEmbeddedFileAssets(store, "![[image.png]]", files, "source.md", hidden));
    const empty = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(empty);
    await waitFor(() => expect(hook.result.current).toHaveLength(1));
    const idle = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(idle);
    expect(readFile).not.toHaveBeenCalled();
    await act(async () => { await store.load(file); });
    expect(hook.result.current).not.toBe(idle);
    expect(hook.result.current[0].asset).toMatchObject({ status: "error", error: "asset failed" });
    const failed = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(failed);
    act(() => store.reset());
    expect(hook.result.current).not.toBe(failed);
    expect(hook.result.current[0].asset.status).toBe("idle");
  });
});
