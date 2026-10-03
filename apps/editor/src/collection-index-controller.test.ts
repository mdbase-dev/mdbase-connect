import { describe, expect, it, vi } from "vitest";
import { CollectionIndexController } from "./collection-index-controller";
import { DemoCollectionGateway } from "./demo-gateway";
import { gatewayError } from "./gateway";

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  expect(check()).toBe(true);
}

describe("editor observe presentation", () => {
  it("publishes progressive SDK pages and keeps one watch owner for hydration", async () => {
    const source = new DemoCollectionGateway(250);
    const observe = vi.spyOn(source, "observe");
    const index = new CollectionIndexController(source, gatewayError);
    const lengths: number[] = [];
    index.subscribe(() => lengths.push(index.getSnapshot().notes.length));
    const load = index.reload();
    expect((await load).notes).toHaveLength(250);
    expect(lengths).toContain(200);
    expect(index.getSnapshot()).toMatchObject({ structureComplete: true, contentComplete: true });
    await index.hydrate();
    expect(observe).toHaveBeenCalledOnce();
    index.reset();
  });

  it("projects SDK watch deltas without bespoke structural reconciliation", async () => {
    const source = new DemoCollectionGateway(2);
    const index = new CollectionIndexController(source);
    await index.reload();
    const before = index.getSnapshot().notes[0]!;
    const changed = await source.updateProperties(before.path, { title: "External title" }, (await source.read(before.path)).revision);
    await until(() => index.getSnapshot().notes.some(note => note.frontmatter.title === "External title"));
    const next = { ...changed, path: "renamed.md" };
    index.upsert(next, before.path);
    expect(index.getSnapshot().notes.some(note => note.path === before.path)).toBe(false);
    index.reset();
  });

  it("cancels loads on collection reset and ignores their late settlement", async () => {
    const source = new DemoCollectionGateway(2);
    let resolve!: (value: Awaited<ReturnType<typeof source.list>>) => void;
    vi.spyOn(source, "list").mockImplementation(() => new Promise(yes => { resolve = yes; }));
    const index = new CollectionIndexController(source);
    const load = index.reload();
    await until(() => !!resolve);
    index.reset(); resolve({ notes: [] });
    expect(await load).toMatchObject({ cancelled: true });
    expect(index.getSnapshot().notes).toEqual([]);
  });
});
