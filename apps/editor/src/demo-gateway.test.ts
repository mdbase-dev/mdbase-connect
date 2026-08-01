import { describe, expect, it } from "vitest";
import { DemoCollectionGateway } from "./demo-gateway";

describe("DemoCollectionGateway indexing", () => {
  it("uses the requested structure snapshot while hydrating content", async () => {
    const gateway = new DemoCollectionGateway(3);
    const structure = await gateway.list();
    const progressSnapshots: Array<string | undefined> = [];

    const content = await gateway.hydrateContent({
      snapshot: structure.snapshot,
      onProgress: (progress) => { progressSnapshots.push(progress.snapshot); }
    });

    expect(content.snapshot).toBe(structure.snapshot);
    expect(progressSnapshots).toEqual([structure.snapshot]);
    expect(content.notes.every((note) => note.body !== undefined)).toBe(true);
  });
});
