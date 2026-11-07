import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../../database-types.js";
import { LogServiceError } from "./log-service-client.js";
import { nextFileBytes, sweepObjects } from "./storage-usage.js";

const ids = (...collections: string[]) => collections.map(collection_id => ({ collection_id }));
const database = (...pages: Array<Array<{ collection_id: string }>>) => {
  const query = vi.fn(async () => ({ rows: pages.shift() ?? [] }));
  return { db: { query } as unknown as DatabaseQueryable, query };
};
const gone = new LogServiceError("gone", undefined);
const notFound = new LogServiceError("not_found", undefined);
const unavailable = new LogServiceError("unavailable", undefined);

describe("nextFileBytes", () => {
  it("adds what each held collection stores, and is zero without collections", async () => {
    const storageStatus = vi.fn(async (id: string) => ({ usedBytes: 1000, quotaBytes: 100, fileBytes: id === "a" ? 10 : 32, fileQuotaBytes: 100 }));
    expect(await nextFileBytes(database(ids("a", "b")).db, { storageStatus }, "owner")).toBe(42);
    expect(await nextFileBytes(database([]).db, { storageStatus }, "owner")).toBe(0);
  });

  it("scopes to the owner and counts collections that left sync until a deletion fact exists", async () => {
    const { db, query } = database([]);
    await nextFileBytes(db, { storageStatus: vi.fn() }, "owner");
    const [sql, values] = query.mock.calls[0] as unknown as [string, string[]];
    expect(values).toEqual(["owner"]);
    expect(sql).toContain("next_collection_deletion_facts");
    expect(sql).not.toContain("left_sync_at");
  });

  it("counts a log that doesn't exist as empty", async () => {
    const storageStatus = vi.fn(async (id: string) => {
      if (id === "a") throw gone;
      if (id === "b") throw notFound;
      return { usedBytes: 1000, quotaBytes: 100, fileBytes: 7, fileQuotaBytes: 100 };
    });
    expect(await nextFileBytes(database(ids("a", "b", "c")).db, { storageStatus }, "owner")).toBe(7);
  });

  it("rejects instead of under-reporting when a collection can't answer", async () => {
    const storageStatus = vi.fn(async (id: string) => {
      if (id === "b") throw unavailable;
      return { usedBytes: 1000, quotaBytes: 100, fileBytes: 7, fileQuotaBytes: 100 };
    });
    await expect(nextFileBytes(database(ids("a", "b")).db, { storageStatus }, "owner")).rejects.toBe(unavailable);
  });
});

describe("sweepObjects", () => {
  it("repeats a full batch and moves on after a partial one", async () => {
    const collectGarbage = vi.fn<(id: string) => Promise<number>>()
      .mockResolvedValueOnce(1000).mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    await sweepObjects(database(ids("a", "b")).db, { collectGarbage }, vi.fn());
    expect(collectGarbage.mock.calls.map(([id]) => id)).toEqual(["a", "a", "b"]);
  });

  it("pages by collection id", async () => {
    const first = ids(...Array.from({ length: 200 }, (_, index) => `c${index}`));
    const { db, query } = database(first, []);
    await sweepObjects(db, { collectGarbage: vi.fn(async () => 0) }, vi.fn());
    expect(query).toHaveBeenCalledTimes(2);
    expect((query.mock.calls[1] as unknown as [string, unknown[]])[1]).toEqual(["c199", 200]);
  });

  it("reports one collection's failure and still sweeps the rest; a missing log isn't a failure", async () => {
    const collectGarbage = vi.fn(async (id: string) => {
      if (id === "a") throw unavailable;
      if (id === "b") throw gone;
      return 0;
    });
    const onError = vi.fn();
    await sweepObjects(database(ids("a", "b", "c")).db, { collectGarbage }, onError);
    expect(collectGarbage).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls).toEqual([[unavailable]]);
  });
});
