import { describe, expect, it, vi } from "vitest";
import { CollectionIndexController, type CollectionIndexSource } from "./collection-index-controller";
import type { NoteIndexRequest, NoteSummary } from "./model";

function note(path: string, body?: string): NoteSummary {
  return {
    path,
    body,
    types: [],
    frontmatter: {},
    effectiveFrontmatter: {},
    file: { path }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("CollectionIndexController", () => {
  it("publishes progressive structure state and exposes the first usable page", async () => {
    const first = note("first.md");
    const second = note("second.md");
    const source: CollectionIndexSource = {
      list: async (options) => {
        options?.onProgress?.({
          notes: [first],
          snapshot: "snapshot-1",
          structureComplete: false,
          complete: false,
          contentComplete: false,
          total: 2
        });
        options?.onProgress?.({
          notes: [first, second],
          snapshot: "snapshot-1",
          structureComplete: true,
          complete: true,
          contentComplete: false,
          total: 2
        });
        return { notes: [first, second], snapshot: "snapshot-1" };
      },
      hydrateContent: async () => ({ notes: [] })
    };
    const controller = new CollectionIndexController(source);
    const states: number[] = [];
    controller.subscribe(() => { states.push(controller.getSnapshot().notes.length); });

    const load = controller.beginLoad();

    await expect(load.firstPage).resolves.toEqual([first]);
    await expect(load.complete).resolves.toEqual({ cancelled: false, notes: [first, second] });
    expect(controller.getSnapshot()).toMatchObject({
      notes: [first, second],
      total: 2,
      listLoading: false,
      structureLoading: false,
      contentComplete: false,
      snapshot: "snapshot-1"
    });
    expect(states).toContain(1);
  });

  it("cancels an older load and ignores a late result even if the source ignores its signal", async () => {
    const oldLoad = deferred<{ notes: NoteSummary[]; snapshot?: string }>();
    let call = 0;
    const source: CollectionIndexSource = {
      list: vi.fn(async () => ++call === 1
        ? oldLoad.promise
        : { notes: [note("current.md")], snapshot: "current" }),
      hydrateContent: async () => ({ notes: [] })
    };
    const controller = new CollectionIndexController(source);
    const first = controller.beginLoad();
    const second = controller.beginLoad();

    await expect(second.complete).resolves.toMatchObject({ cancelled: false });
    oldLoad.resolve({ notes: [note("stale.md")], snapshot: "stale" });
    await expect(first.complete).resolves.toEqual({ cancelled: true, notes: [] });
    expect(controller.getSnapshot().notes.map((item) => item.path)).toEqual(["current.md"]);
  });

  it("hydrates against the structure snapshot without resurrecting an accepted deletion", async () => {
    let hydrationRequest: NoteIndexRequest | undefined;
    const hydration = deferred<{ notes: NoteSummary[]; snapshot?: string }>();
    const source: CollectionIndexSource = {
      list: async () => ({ notes: [note("kept.md"), note("deleted.md")], snapshot: "structure" }),
      hydrateContent: async (options) => {
        hydrationRequest = options;
        return hydration.promise;
      }
    };
    const controller = new CollectionIndexController(source);
    await controller.reload();

    const loading = controller.hydrate();
    controller.stageRemoval("deleted.md");
    controller.commitRemoval("deleted.md");
    hydration.resolve({ notes: [note("kept.md", "loaded"), note("deleted.md", "stale")] });
    await loading;

    expect(hydrationRequest).toMatchObject({ snapshot: "structure" });
    expect(controller.getSnapshot().notes).toEqual([note("kept.md", "loaded")]);
  });

  it("does not erase content that hydrates after structure progress but before list settlement", async () => {
    const structure = note("one.md");
    const loaded = note("one.md", "loaded between callbacks");
    let controller!: CollectionIndexController;
    let hydrationStarted = false;
    const source: CollectionIndexSource = {
      list: async (options) => {
        options?.onProgress?.({
          notes: [structure],
          snapshot: "structure",
          structureComplete: true,
          complete: true,
          contentComplete: false,
          total: 1
        });
        await controller.hydrate();
        return { notes: [structure], snapshot: "structure" };
      },
      hydrateContent: async (options) => {
        hydrationStarted = true;
        options?.onProgress?.({
          notes: [loaded],
          snapshot: options.snapshot,
          structureComplete: true,
          complete: true,
          contentComplete: true,
          contentLoaded: 1,
          total: 1
        });
        return { notes: [loaded], snapshot: options?.snapshot };
      }
    };
    controller = new CollectionIndexController(source);

    await controller.reload();

    expect(hydrationStarted).toBe(true);
    expect(controller.getSnapshot().notes[0]?.body).toBe("loaded between callbacks");
  });

  it("retires mutation overlays after a refresh begun after the mutation", async () => {
    let current = [note("one.md", "initial")];
    const source: CollectionIndexSource = {
      list: async () => ({ notes: current, snapshot: "fresh" }),
      hydrateContent: async () => ({ notes: [] })
    };
    const controller = new CollectionIndexController(source);
    await controller.reload();
    controller.upsert(note("one.md", "locally accepted"));
    current = [note("one.md", "remote authority")];

    await controller.reload();
    current = [note("one.md", "later remote edit")];
    await controller.reload();

    expect(controller.getSnapshot().notes[0]?.body).toBe("later remote edit");
  });

  it("retains a failed partial inventory as incomplete and clears the error on retry", async () => {
    const notes = Array.from({ length: 8295 }, (_, i) => note(`${i}.md`));
    let fail = true;
    const source: CollectionIndexSource = {
      list: async (options) => {
        options?.onProgress?.({ notes: notes.slice(0, 400), total: notes.length,
          structureComplete: false, complete: false, contentComplete: false });
        if (fail) throw new Error("Third page unavailable");
        return { notes };
      },
      hydrateContent: async () => ({ notes })
    };
    const controller = new CollectionIndexController(source);
    const load = controller.beginLoad();
    await expect(load.firstPage).resolves.toHaveLength(400);
    await expect(load.complete).rejects.toThrow("Third page unavailable");
    expect(controller.getSnapshot()).toMatchObject({ total: 8295,
      structureComplete: false, contentComplete: false, listLoading: false,
      structureLoading: false, structureError: "Third page unavailable" });
    expect(controller.getSnapshot().notes).toHaveLength(400);
    fail = false;
    const retry = controller.beginLoad();
    expect(controller.getSnapshot().structureError).toBeUndefined();
    await retry.complete;
    expect(controller.getSnapshot()).toMatchObject({ structureComplete: true, structureError: undefined });
    expect(controller.getSnapshot().notes).toHaveLength(8295);
  });

  it("does not publish an obsolete request's error after a successful reload", async () => {
    const stale = deferred<{ notes: NoteSummary[] }>();
    let first = true;
    const controller = new CollectionIndexController({
      list: async () => { if (first) { first = false; return stale.promise; } return { notes: [] }; },
      hydrateContent: async () => ({ notes: [] })
    });
    const old = controller.beginLoad();
    await controller.reload();
    stale.reject(new Error("Obsolete failure"));
    await expect(old.complete).resolves.toMatchObject({ cancelled: true });
    expect(controller.getSnapshot().structureError).toBeUndefined();
  });

  it("keeps a failed hydration retryable and reports its error", async () => {
    let attempt = 0;
    const source: CollectionIndexSource = {
      list: async () => ({ notes: [note("one.md")], snapshot: "one" }),
      hydrateContent: async () => {
        if (++attempt === 1) throw new Error("offline");
        return { notes: [note("one.md", "loaded")] };
      }
    };
    const controller = new CollectionIndexController(source);
    await controller.reload();

    await controller.hydrate();
    expect(controller.getSnapshot()).toMatchObject({ contentError: "offline", contentIndexing: false });
    await controller.hydrate();
    expect(controller.getSnapshot()).toMatchObject({ contentComplete: true, contentError: undefined });
  });
});
