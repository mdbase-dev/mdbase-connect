import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileAssetStore } from "./file-asset-store";
import type { CollectionFile } from "./model";

beforeEach(() => {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn((blob: Blob) => `blob:${blob.size}`),
    revokeObjectURL: vi.fn()
  });
});

describe("FileAssetStore", () => {
  it("deduplicates downloads and keys assets by revision", async () => {
    const readFile = vi.fn(async () => new Blob(["image"]));
    const store = new FileAssetStore({ readFile });
    const original = file("one.png", "r1", 5);
    const release = store.acquire(original);
    const [left, right] = await Promise.all([store.load(original), store.load(original)]);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(left.status).toBe("ready");
    expect(right.status).toBe("ready");
    release();

    await store.load({ ...original, revision: "r2" });
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:5");
  });

  it("does not buffer files beyond the preview ceiling", async () => {
    const readFile = vi.fn(async () => new Blob());
    const store = new FileAssetStore({ readFile }, { maxPreviewBytes: 8 });
    const snapshot = await store.load(file("large.mp4", "r1", 9));
    expect(snapshot.status).toBe("too_large");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used unreferenced assets within its byte budget", async () => {
    const readFile = vi.fn(async (value: CollectionFile) => new Blob([value.path]));
    const store = new FileAssetStore({ readFile }, { maxCacheBytes: 10, maxEntries: 2 });
    await store.load(file("one.png", "r1", 6, "1"));
    await store.load(file("two.png", "r1", 6, "2"));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});

function file(path: string, revision: string, size: number, id = "1"): CollectionFile {
  return {
    fileId: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    path,
    revision,
    contentDigest: `sha256:${id.padStart(64, "0")}`,
    size,
    mediaClass: path.endsWith(".mp4") ? "video" : "image",
    modifiedAt: "2026-08-07T00:00:00Z"
  };
}
