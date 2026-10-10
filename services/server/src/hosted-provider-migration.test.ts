import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedProviderClient } from "./hosted-provider.js";

const collection = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const run = "7c18af2e-b04a-4b77-b83e-493c3695962e";
const drain = { collection_id: collection, state: "migrating", migration_id: run, head: 42,
  started_at: "2026-10-10T12:00:00Z", retain_until: null, in_flight: 0, unresolved: 3, applied_unreceipted: 2 };
const fence = { collection_id: collection, state: "migrating", migration_id: run,
  started_at: drain.started_at, retain_until: null, restored: [] };
const provider = () => new HostedProviderClient({ url: "https://provider.example", internalToken: "synthetic-test" });
afterEach(() => vi.restoreAllMocks());

describe("typed bounded legacy migration provider actions", () => {
  it("keeps retained journal evidence and the exact provider run, without rounding counters", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(drain));
    await expect(provider().legacyMigrationDrain(collection)).resolves.toEqual(drain);
  });
  it.each([
    { ...drain, collection_id: run }, { ...drain, head: Number.MAX_SAFE_INTEGER + 1 },
    { ...drain, in_flight: -1 }, { ...drain, unresolved: "3" }, { ...drain, applied_unreceipted: 0.5 },
    { ...drain, migration_id: "bad" }, { ...drain, started_at: "not-a-time" }, { ...drain, extra: true }, {}
  ])("refuses malformed or mismatched drain facts (%j)", async body => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    await expect(provider().legacyMigrationDrain(collection)).rejects.toThrow();
  });
  it("fences using the existing provider transition without caller retention/restore/escape-hatch facts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(fence));
    await expect(provider().legacyMigrationFence(collection)).resolves.toEqual(fence);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://provider.example/internal/v1/collections/${collection}/legacy-migration`);
    expect(init?.method).toBe("PUT"); expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toEqual({ state: "migrating" });
  });
  it("retries a lost fence reply with the same transition, preserving its provider identity", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValueOnce(Response.json(fence));
    await expect(provider().legacyMigrationFence(collection)).resolves.toEqual(fence);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(fetchMock.mock.calls[1]![1]?.body);
  });
  it.each([{ ...fence, collection_id: run }, { ...fence, state: "active" }, { ...fence, migration_id: null },
    { ...fence, started_at: null }, { ...fence, restored: [run] }, {}])("never acknowledges an invalid fence (%j)", async body => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    await expect(provider().legacyMigrationFence(collection)).rejects.toThrow();
  });
  it("bounds every fence reply before JSON decoding", async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4097).fill(32)); }, cancel
    }, { highWaterMark: 0 })));
    await expect(provider().legacyMigrationFence(collection)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(3);
  });
  it.each([collection.toUpperCase(), "00000000-0000-0000-0000-000000000000", `${collection}\n`, "bad"]) (
    "rejects noncanonical/nil identifiers before fetching: %s", async id => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      await expect(provider().legacyMigrationFence(id)).rejects.toThrow();
      await expect(provider().legacyMigrationDrain(id)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
});
