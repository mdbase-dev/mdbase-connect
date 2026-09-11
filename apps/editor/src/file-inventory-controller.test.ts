import { describe, expect, it, vi } from "vitest";
import { FileInventoryController } from "./file-inventory-controller";
import type { CollectionFile, CollectionGateway } from "./model";

describe("FileInventoryController", () => {
  it("publishes progressive descriptor inventory and completes in stable path order", async () => {
    const first = file("b.png", "1");
    const second = file("A.pdf", "2");
    const source = {
      listFiles: vi.fn(async ({ onProgress }: Parameters<CollectionGateway["listFiles"]>[0] = {}) => {
        onProgress?.({ files: [first], complete: false });
        return [first, second];
      })
    };
    const controller = new FileInventoryController(source);
    const snapshots: string[][] = [];
    controller.subscribe(() => snapshots.push(controller.getSnapshot().files.map(({ path }) => path)));

    await controller.reload();

    expect(snapshots).toContainEqual(["b.png"]);
    expect(controller.getSnapshot()).toMatchObject({
      files: [second, first],
      loading: false,
      complete: true
    });
  });

  it("keeps the latest request authoritative", async () => {
    let resolveFirst!: (files: CollectionFile[]) => void;
    const source = {
      listFiles: vi.fn()
        .mockImplementationOnce(() => new Promise<CollectionFile[]>((resolve) => { resolveFirst = resolve; }))
        .mockResolvedValueOnce([file("latest.png", "2")])
    };
    const controller = new FileInventoryController(source);
    const first = controller.reload();
    await controller.reload();
    resolveFirst([file("stale.png", "1")]);
    await first;

    expect(controller.getSnapshot().files.map(({ path }) => path)).toEqual(["latest.png"]);
  });

  it("reconciles descriptors by stable file id", () => {
    const controller = new FileInventoryController({ listFiles: vi.fn().mockResolvedValue([]) });
    const original = file("Photos/one.png", "1");
    controller.upsert(original);
    controller.upsert({ ...original, path: "Archive/one.png", revision: "r2" });
    expect(controller.getSnapshot().files).toEqual([{ ...original, path: "Archive/one.png", revision: "r2" }]);
    controller.remove(original.fileId);
    expect(controller.getSnapshot().files).toEqual([]);
  });

  it("sorts 10,000 files once across 100 cumulative progress snapshots", async () => {
    const files = Array.from({ length: 10_000 }, (_, i) => file(`image${10_000 - i}.png`, String(i)));
    const originalSort = Array.prototype.sort;
    let sorts = 0;
    let comparisons = 0;
    const sort = vi.spyOn(Array.prototype, "sort").mockImplementation(function<T>(this: T[], compare?: (a: T, b: T) => number): T[] {
      const isInventory = this.length > 0 && typeof this[0] === "object" && this[0] !== null && "fileId" in this[0];
      if (isInventory) sorts += 1;
      return originalSort.call(this, compare && ((a: T, b: T) => {
        if (isInventory) comparisons += 1;
        return compare(a, b);
      })) as T[];
    });
    try {
      let progressCount = 0;
      const controller = new FileInventoryController({
        listFiles: vi.fn(async ({ onProgress } = {}) => {
          for (let count = 100; count <= files.length; count += 100) {
            const batch = files.slice(0, count);
            onProgress?.({ files: batch, complete: count === files.length });
            const snapshot = controller.getSnapshot();
            expect(snapshot.files).toEqual(batch);
            expect(snapshot.files).not.toBe(batch);
            expect(snapshot.error).toBeUndefined();
            expect(snapshot.loading).toBe(count < files.length);
            progressCount += 1;
          }
          return files;
        })
      });
      const result = await controller.reload();
      expect(progressCount).toBe(100);
      expect(sorts).toBe(1);
      expect(comparisons).toBeLessThan(200_000);
      expect(result.map(({ path }) => path)).toEqual(Array.from({ length: 10_000 }, (_, i) => `image${i + 1}.png`));
      expect(controller.getSnapshot().files).toBe(result);
      expect(files[0].path).toBe("image10000.png");
    } finally {
      sort.mockRestore();
    }
  });

  it("matches numeric/base locale order and retains source order for equal paths", async () => {
    const files = ["z10.png", "Z2.png", "á1.png", "A1.png", "a1.png", "folder/11.png", "folder/2.png"]
      .map((path, i) => file(path, String(i)));
    const expected = [...files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
    const controller = new FileInventoryController({ listFiles: vi.fn().mockResolvedValue(files) });
    expect(await controller.reload()).toEqual(expected);
    expect(controller.getSnapshot().files.filter(({ path }) => /1\.png$/.test(path)).slice(0, 3)).toEqual(files.slice(2, 5));
  });

  it("preserves usable progress on failure, propagates the error, and clears it on retry", async () => {
    const partial = [file("z.png", "1"), file("a.png", "2")];
    const failure = new Error("offline");
    const source = {
      listFiles: vi.fn<CollectionGateway["listFiles"]>()
        .mockImplementationOnce(async ({ onProgress } = {}) => {
          onProgress?.({ files: partial, complete: false });
          throw failure;
        })
        .mockResolvedValueOnce(partial)
    };
    const controller = new FileInventoryController(source);
    await expect(controller.reload()).rejects.toBe(failure);
    expect(controller.getSnapshot()).toEqual({ files: partial, loading: false, complete: false, error: "offline" });
    const retry = controller.reload();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, complete: false, error: undefined });
    expect(await retry).toEqual([partial[1], partial[0]]);
    expect(controller.getSnapshot()).toMatchObject({ loading: false, complete: true });
  });

  it.each(["resolve", "reject"] as const)("ignores stale progress and %s after reset", async (settlement) => {
    let options!: Parameters<CollectionGateway["listFiles"]>[0];
    let resolve!: (files: CollectionFile[]) => void;
    let reject!: (error: Error) => void;
    const stale = [file("stale.png", "1")];
    const latest = [file("latest.png", "2")];
    const source = {
      listFiles: vi.fn<CollectionGateway["listFiles"]>()
        .mockImplementationOnce((value) => {
          options = value;
          return new Promise((yes, no) => { resolve = yes; reject = no; });
        })
        .mockResolvedValueOnce(latest)
    };
    const controller = new FileInventoryController(source);
    const first = controller.reload();
    controller.reset();
    expect(options?.signal?.aborted).toBe(true);
    options?.onProgress?.({ files: stale, complete: true });
    expect(controller.getSnapshot()).toEqual({ files: [], loading: false, complete: false });
    await controller.reload();
    options?.onProgress?.({ files: stale, complete: false });
    if (settlement === "resolve") resolve(stale);
    else reject(new Error("stale failure"));
    expect(await first).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({ files: latest, complete: true, loading: false });
  });
});

function file(path: string, id: string): CollectionFile {
  return {
    fileId: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    path,
    revision: `r${id}`,
    contentDigest: `sha256:${id.padStart(64, "0")}`,
    size: 10,
    mediaClass: path.endsWith(".pdf") ? "pdf" : "image",
    modifiedAt: "2026-08-07T00:00:00Z"
  };
}
