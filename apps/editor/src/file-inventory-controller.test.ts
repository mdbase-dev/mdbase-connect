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
