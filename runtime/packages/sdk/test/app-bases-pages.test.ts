import { describe, expect, it } from "vitest";
import { appBasesPages } from "../src/app-host/bases-pages.js";
import type { AppBasesRequest, AppBasesResult } from "../src/app-host/bases-wire.js";

const request = { view: "tasks" } as unknown as AppBasesRequest;
const page = (offset: number, limit: number, total: number, revision = "sha256:aa"): AppBasesResult => ({
  kind: "success",
  rows: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ i: offset + i })),
  collectionRevision: revision,
  window: { offset, limit, totalMatchedRows: total, groupPlacements: [] },
} as unknown as AppBasesResult);

describe("saved-view pages over native windows", () => {
  it("advances by returned rows until the matched rows are exhausted", async () => {
    const asked: { offset: number; limit: number }[] = [];
    const pages = [];
    for await (const p of appBasesPages(async (r) => { asked.push(r.window!); return page(r.window!.offset, r.window!.limit, 5); }, request, { firstPageSize: 2, pageSize: 3 })) pages.push(p);
    expect(asked).toEqual([{ offset: 0, limit: 2 }, { offset: 2, limit: 3 }]);
    expect(pages.map((p) => p.kind === "success" && [p.page, p.offset, p.loaded, p.complete, p.changedSinceFirst])).toEqual([[0, 0, 2, false, false], [1, 2, 5, true, false]]);
  });

  it("marks pages read after the collection changed and stops at a refusal", async () => {
    let n = 0;
    const seen = [];
    for await (const p of appBasesPages(async (r) => {
      n += 1;
      if (n === 3) return { kind: "refusal", problem: { code: "forbidden" } } as unknown as AppBasesResult;
      return page(r.window!.offset, r.window!.limit, 10, n === 1 ? "sha256:aa" : "sha256:bb");
    }, request, { firstPageSize: 2, pageSize: 2 })) seen.push(p);
    expect(seen.map((p) => p.kind === "success" ? p.changedSinceFirst : p.kind)).toEqual([false, true, "refusal"]);
    await expect(appBasesPages(async () => page(0, 1, 1), request, { pageSize: 65537 }).next()).rejects.toMatchObject({ code: "invalid_request" });
  });
});
