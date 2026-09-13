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

  it.each(["error", "too_large"] as const)("bounds released %s entries without ready URLs", async (status) => {
    const readFile = vi.fn(async () => { throw new Error("offline"); });
    const store = new FileAssetStore({ readFile }, { maxEntries: 3, maxPreviewBytes: 8 });
    const files = Array.from({ length: 100 }, (_, i) => file(`${i}.png`, "r1", status === "too_large" ? 9 : 1, String(i)));
    for (const current of files) {
      const release = store.acquire(current);
      expect((await store.load(current)).status).toBe(status);
      release();
      expect(files.filter((value) => store.get(value).status !== "idle").length).toBeLessThanOrEqual(3);
    }
    expect(files.slice(-3).map((value) => store.get(value).status)).toEqual([status, status, status]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledTimes(status === "error" ? 100 : 0);
  });

  it.each(["error", "too_large"] as const)("bounds load-only %s entries", async (status) => {
    const store = new FileAssetStore({ readFile: vi.fn().mockRejectedValue(new Error("offline")) }, {
      maxEntries: 2, maxPreviewBytes: 8
    });
    const files = Array.from({ length: 20 }, (_, i) => file(`${i}.png`, "r1", status === "too_large" ? 9 : 1, String(i)));
    for (const current of files) await store.load(current);
    expect(files.filter((value) => store.get(value).status !== "idle")).toEqual(files.slice(-2));
  });

  it("keeps failed snapshots passive but retries on reacquisition for visible embeds", async () => {
    const readFile = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Blob(["ok"]));
    const store = new FileAssetStore({ readFile });
    const current = file("one.png", "r1", 2);
    await store.load(current);
    for (let i = 0; i < 10; i++) expect(store.get(current).status).toBe("error");
    expect(readFile).toHaveBeenCalledTimes(1);
    const release = store.acquire(current);
    expect((await store.load(current)).status).toBe("ready");
    release();
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("aborts abandoned in-flight entries at the entry limit and ignores late settlement", async () => {
    const pending: { signal?: AbortSignal; resolve: (blob: Blob) => void }[] = [];
    const readFile = vi.fn((_file: CollectionFile, options?: { signal?: AbortSignal }) => new Promise<Blob>((resolve) => {
      pending.push({ signal: options?.signal, resolve });
    }));
    const store = new FileAssetStore({ readFile }, { maxEntries: 2 });
    const files = Array.from({ length: 10 }, (_, i) => file(`${i}.png`, "r1", 1, String(i)));
    const loads = files.map((current, i) => {
      // Cover both abandoned acquire() and the load-only path.
      const release = i % 2 === 0 ? store.acquire(current) : undefined;
      const load = store.load(current);
      release?.();
      return load;
    });
    expect(pending.map(({ signal }) => signal?.aborted)).toEqual([...Array(8).fill(true), false, false]);
    expect(files.filter((value) => store.get(value).status === "loading")).toEqual(files.slice(-2));
    pending.forEach(({ resolve }) => resolve(new Blob(["x"])));
    await Promise.all(loads);
    expect(files.slice(0, -2).every((value) => store.get(value).status === "idle")).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    store.reset();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("keeps all referenced statuses pinned and restores bounds on idempotent release", async () => {
    const readFile = vi.fn(async (value: CollectionFile) => {
      if (value.path === "error.png") throw new Error("offline");
      return new Blob(["ok"]);
    });
    const store = new FileAssetStore({ readFile }, { maxEntries: 1, maxCacheBytes: 1, maxPreviewBytes: 8 });
    const files = [file("ready.png", "r1", 2, "1"), file("error.png", "r1", 1, "2"), file("large.png", "r1", 9, "3")];
    const releases = files.map((value) => store.acquire(value));
    await Promise.all(files.map((value) => store.load(value)));
    expect(files.map((value) => store.get(value).status)).toEqual(["ready", "error", "too_large"]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    releases[1]();
    releases[1]();
    expect(store.get(files[1]).status).toBe("idle");
    expect(store.get(files[0]).status).toBe("ready");
    releases[0]();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(store.get(files[2]).status).toBe("too_large");
    releases[2]();
    store.reset();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it.each(["reset", "invalidate"] as const)("fences late reads after %s and leaves a replacement request alone", async (action) => {
    const pending: { resolve: (blob: Blob) => void; signal?: AbortSignal }[] = [];
    const store = new FileAssetStore({ readFile: vi.fn((_file, options) => new Promise<Blob>((resolve) => {
      pending.push({ resolve, signal: options?.signal });
    })) });
    const current = file("one.png", "r1", 1);
    const old = store.load(current);
    if (action === "reset") store.reset();
    else store.invalidate(current.fileId);
    const replacement = store.load(current);
    const version = store.getVersion();
    pending[0].resolve(new Blob(["old"]));
    await old;
    expect(pending[0].signal?.aborted).toBe(true);
    expect(store.getVersion()).toBe(version);
    expect(store.get(current).status).toBe("loading");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    pending[1].resolve(new Blob(["new"]));
    await replacement;
    expect(store.get(current).status).toBe("ready");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("revokes every owned URL exactly once across retry, revision, eviction and reset", async () => {
    let nextUrl = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:owned-${++nextUrl}`);
    const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob(["ok"])) }, { maxEntries: 1 });
    const current = file("one.png", "r1", 2);
    await store.load(current);
    await store.retry(current);
    await store.load({ ...current, revision: "r2" });
    await store.load(file("two.png", "r1", 2, "2"));
    store.reset();
    store.reset();
    store.invalidate(current.fileId);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([
      ["blob:owned-1"], ["blob:owned-2"], ["blob:owned-3"], ["blob:owned-4"]
    ]);
  });

  it("pins a shared pending read until the last consumer releases it", async () => {
    let resolve!: (blob: Blob) => void;
    let signal: AbortSignal | undefined;
    const readFile = vi.fn((_file, options) => {
      signal = options?.signal;
      return new Promise<Blob>((yes) => { resolve = yes; });
    });
    const store = new FileAssetStore({ readFile }, { maxEntries: 0 });
    const current = file("one.png", "r1", 1);
    const first = store.acquire(current);
    const second = store.acquire(current);
    const loading = store.retry(current);
    expect(readFile).toHaveBeenCalledTimes(1);
    first();
    first();
    expect(signal?.aborted).toBe(false);
    expect(store.get(current).status).toBe("loading");
    second();
    expect(signal?.aborted).toBe(true);
    expect(store.get(current).status).toBe("idle");
    resolve(new Blob(["late"]));
    await loading;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("enforces a zero-entry budget for immediate oversized loads and retries", async () => {
    const readFile = vi.fn().mockResolvedValue(new Blob());
    const store = new FileAssetStore({ readFile }, { maxEntries: 0, maxPreviewBytes: 1 });
    const current = file("large.png", "r1", 2);
    expect((await store.load(current)).status).toBe("idle");
    expect((await store.retry(current)).status).toBe("idle");
    const release = store.acquire(current);
    expect((await store.retry(current)).status).toBe("too_large");
    release();
    expect(store.get(current).status).toBe("idle");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("ignores a rejected evicted request without publishing stale errors", async () => {
    let reject!: (error: Error) => void;
    const readFile = vi.fn().mockImplementationOnce(() => new Promise<Blob>((_yes, no) => { reject = no; }))
      .mockResolvedValue(new Blob(["ok"]));
    const store = new FileAssetStore({ readFile }, { maxEntries: 1 });
    const current = file("one.png", "r1", 1);
    const old = store.load(current);
    await store.load(file("two.png", "r1", 1, "2"));
    const version = store.getVersion();
    reject(new Error("late error"));
    await old;
    expect(store.getVersion()).toBe(version);
    expect(store.get(current).status).toBe("idle");
  });

  it("uses access order even when the clock does not advance", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1);
    try {
      const store = new FileAssetStore({ readFile: vi.fn().mockResolvedValue(new Blob()) }, { maxEntries: 2 });
      const files = [1, 2, 3].map((id) => file(`${id}.png`, "r1", 1, String(id)));
      await store.load(files[0]);
      await store.load(files[1]);
      await store.load(files[0]);
      await store.load(files[2]);
      expect(files.map((value) => store.get(value).status)).toEqual(["ready", "idle", "ready"]);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
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
