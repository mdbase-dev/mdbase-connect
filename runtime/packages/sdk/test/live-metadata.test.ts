import { describe, expect, it, vi } from "vitest";
import { LiveResult } from "../src/live.js";
import { LiveQuery, type MdbaseClient } from "../src/client.js";
import type { QueryMetadata, QueryUpdate } from "../src/wire.js";
const update = (kind: QueryUpdate["kind"], asOf: number, metadata?: QueryMetadata): QueryUpdate =>
  ({ sub: 1, kind, complete: true, asOf, ...(metadata === undefined ? {} : { metadata }) });
const first: QueryMetadata = { columns: ["label"], totalCount: 12, groups: [], hasMore: true };

describe("full live query metadata replacement", () => {
  it("exposes metadata on the snapshot at exactly its enclosing asOf", () => {
    const result = new LiveResult();
    result.apply(update("snapshot", 7, first));
    expect(result.metadata).toEqual(first); expect(result.asOf).toBe(7);
  });
  it("replaces rather than merges a metadata-only diff, including same-asOf", () => {
    const result = new LiveResult(); result.apply(update("snapshot", 7, first));
    result.apply(update("diff", 7, { totalCount: 0, hasMore: false }));
    expect(result.metadata).toEqual({ totalCount: 0, hasMore: false });
    expect(result.metadata).not.toHaveProperty("columns");
    expect(result.metadata).not.toHaveProperty("groups");
  });
  it("omitted metadata is unknown, not old metadata or fabricated empty results", () => {
    const result = new LiveResult(); result.apply(update("snapshot", 7, first));
    result.apply(update("diff", 8));
    expect(result.metadata).toBeUndefined(); expect(result.asOf).toBe(8);
  });
  it("reset discards metadata even when the reset packet contains metadata", () => {
    const result = new LiveResult(); result.apply(update("snapshot", 7, first));
    result.apply(update("reset", 8, first));
    expect(result.stale).toBe(true); expect(result.metadata).toBeUndefined();
    result.apply(update("diff", 9, first));
    expect(result.metadata).toBeUndefined();
    result.apply(update("snapshot", 10, { groups: [], totalCount: 0, hasMore: false }));
    expect(result.metadata).toEqual({ groups: [], totalCount: 0, hasMore: false });
    expect(result.stale).toBe(false);
  });
  it("reconnect/query-change staleness immediately discards old metadata", () => {
    const result = new LiveResult(); result.apply(update("snapshot", 7, first));
    result.markStale(); expect(result.metadata).toBeUndefined();
    result.apply(update("snapshot", 11)); expect(result.metadata).toBeUndefined();
  });
  it("public live listeners observe same-asOf metadata replacement and close purges it", () => {
    // LiveQuery state/listener unit seam, not a native producer stand-in.
    const close = vi.fn();
    const live = new LiveQuery({ _closeLive: close } as unknown as MdbaseClient, {}, undefined);
    const observed: (QueryMetadata | undefined)[] = [];
    live.subscribe(state => observed.push(state.metadata));
    live._apply(update("snapshot", 7, first));
    live._apply(update("diff", 7, { totalCount: 1 }));
    expect(observed).toEqual([undefined, first, { totalCount: 1 }]);
    live.close(); expect(live.metadata).toBeUndefined();
    live._apply(update("snapshot", 8, first));
    expect(live.metadata).toBeUndefined(); expect(observed).toHaveLength(3);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
