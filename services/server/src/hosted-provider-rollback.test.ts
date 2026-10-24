import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedProviderClient, HostedProviderResponseError, HostedProviderUnavailableError } from "./hosted-provider.js";

const uuid = (value: number) => `${value.toString(16).padStart(8, "0")}-1234-4234-8234-123456789abc`;
const collection = uuid(1);
const nativeBinding = { owner_account_id: uuid(2), provider_migration_id: uuid(3), authority_epoch: 4,
  fixed_head: 5, driver_id: uuid(6), action_id: uuid(7), replica_ids: [uuid(9), uuid(8)] };
const binding = { provider_account_id: uuid(12), binding: nativeBinding };
const receipt = { collection_id: collection, binding: { ...nativeBinding, replica_ids: [uuid(8), uuid(9)] },
  restored_ids: [uuid(9)], recorded_at: "2026-10-10T16:00:00Z" };
const provider = () => new HostedProviderClient({ url: "https://provider.example", internalToken: "synthetic-test" });
const methods = ["legacyMigrationRollback", "legacyMigrationRollbackReceipt"] as const;
afterEach(() => vi.restoreAllMocks());

describe.each(methods)("bounded exact metadata-only %s", method => {
  it("uses the dedicated authenticated route and canonical immutable scope", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(receipt));
    await expect(provider()[method](collection, binding)).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://provider.example/internal/v1/collections/${collection}/legacy-migration/${method === "legacyMigrationRollback" ? "rollback-v2" : "rollback-receipt-v2"}`);
    expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("manual");
    expect(init?.headers).toMatchObject({ authorization: "Bearer synthetic-test" });
    expect(JSON.parse(String(init?.body))).toEqual({ provider_account_id: uuid(12), binding: receipt.binding });
    expect(nativeBinding.replica_ids).toEqual([uuid(9), uuid(8)]);
    expect(receipt.binding.owner_account_id).not.toBe(binding.provider_account_id);
  });
  it("accepts empty and partly restored scopes without inventing a grant", async () => {
    const emptyBinding = { ...nativeBinding, replica_ids: [] };
    const emptyReceipt = { ...receipt, binding: emptyBinding, restored_ids: [] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(emptyReceipt));
    await expect(provider()[method](collection, { ...binding, binding: emptyBinding })).resolves.toEqual(emptyReceipt);
  });
  it("accepts the full1000-ID scope and exact maximum safe counters within the byte bound", async () => {
    const replicaIds = Array.from({ length: 1000 }, (_, i) => uuid(i + 20));
    const maximumBinding = { ...nativeBinding, authority_epoch: Number.MAX_SAFE_INTEGER,
      fixed_head: Number.MAX_SAFE_INTEGER, replica_ids: replicaIds };
    const maximumReceipt = { ...receipt, binding: maximumBinding, restored_ids: replicaIds };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(maximumReceipt));
    await expect(provider()[method](collection, { ...binding, binding: maximumBinding })).resolves.toEqual(maximumReceipt);
  });
  it.each(["owner_account_id", "provider_migration_id", "driver_id", "action_id"] as const)(
    "refuses a different %s", async field => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...receipt, binding: { ...receipt.binding, [field]: uuid(10) } }));
      await expect(provider()[method](collection, binding)).rejects.toThrow("binding does not match");
    });
  it.each([
    { ...receipt, collection_id: uuid(10) },
    { ...receipt, binding: { ...receipt.binding, authority_epoch: 5 } },
    { ...receipt, binding: { ...receipt.binding, fixed_head: 6 } },
    { ...receipt, binding: { ...receipt.binding, replica_ids: [uuid(9)] } },
    { ...receipt, binding: { ...receipt.binding, replica_ids: [uuid(9), uuid(9)] } },
    { ...receipt, binding: { ...receipt.binding, fixed_head: Number.MAX_SAFE_INTEGER + 1 } },
    { ...receipt, binding: { ...receipt.binding, authority_epoch: "4" } },
    { ...receipt, restored_ids: [uuid(10)] }, { ...receipt, restored_ids: [uuid(9), uuid(9)] },
    { ...receipt, restored_ids: Array.from({ length: 1001 }, (_, i) => uuid(i + 20)) },
    { ...receipt, recorded_at: "not-a-date" }, { ...receipt, verified: true },
    { collection_id: collection, state: "active" }, {}, undefined
  ])("never substitutes malformed/current-active/foreign evidence (%j)", async body => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body ?? null));
    await expect(provider()[method](collection, binding)).rejects.toThrow();
  });
  it.each([
    { ...nativeBinding, authority_epoch: 0 }, { ...nativeBinding, authority_epoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...nativeBinding, fixed_head: -1 }, { ...nativeBinding, fixed_head: 0.5 },
    { ...nativeBinding, replica_ids: [uuid(9), uuid(9)] },
    { ...nativeBinding, replica_ids: Array.from({ length: 1001 }, (_, i) => uuid(i + 20)) },
    { ...nativeBinding, action_id: "00000000-0000-0000-0000-000000000000" },
    { ...nativeBinding, driver_id: `${uuid(6)}\n` }, { ...nativeBinding, provider_migration_id: uuid(3).toUpperCase() },
    { ...nativeBinding, verified: true }
  ])("refuses malformed input before any request (%j)", async input => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(provider()[method](collection, { ...binding, binding: input })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    nativeBinding, { binding: nativeBinding }, { provider_account_id: uuid(12) },
    { ...binding, provider_account_id: "00000000-0000-0000-0000-000000000000" },
    { ...binding, provider_account_id: uuid(12).toUpperCase() }, { ...binding, force: true },
    { ...binding, binding: { ...nativeBinding, provider_account_id: uuid(12) } }
  ])("refuses a missing, malformed or caller-expanded physical envelope (%j)", async input => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(provider()[method](collection, input as never)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("bounds reply bytes before decoding, cancels once, and never repeats the request", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1).fill(32)); }, cancel
    }, { highWaterMark: 0 })));
    await expect(provider()[method](collection, binding)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("treats a lost response as UNKNOWN without retry, active-only fallback or a different route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("lost reply"));
    await expect(provider()[method](collection, binding)).rejects.toBeInstanceOf(HostedProviderUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([404, 429, 502, 503, 504])("does not repeat status %s", async status => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(
      { error: { code: "legacy_rollback_receipt_unknown", message: "No exact receipt." } }, { status }));
    await expect(provider()[method](collection, binding)).rejects.toMatchObject({
      status, code: "legacy_rollback_receipt_unknown"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects nil collection/cancellation without fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(provider()[method]("00000000-0000-0000-0000-000000000000", binding)).rejects.toThrow();
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(provider()[method](collection, binding, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it("a lost mutation is followed only by an explicitly requested original-binding lookup", async () => {
  const client = provider();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("lost reply"))
    .mockResolvedValueOnce(Response.json(receipt));
  await expect(client.legacyMigrationRollback(collection, binding)).rejects.toBeInstanceOf(HostedProviderUnavailableError);
  await expect(client.legacyMigrationRollbackReceipt(collection, binding)).resolves.toEqual(receipt);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]![1]?.body).toBe(fetchMock.mock.calls[1]![1]?.body);
  expect(fetchMock.mock.calls[1]![0]).toContain("rollback-receipt");
});

it("does not accept a later Unfence ID as the saved original restore binding", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(receipt));
  await expect(provider().legacyMigrationRollbackReceipt(collection, { ...binding, binding: { ...nativeBinding, action_id: uuid(10) } }))
    .rejects.toBeInstanceOf(HostedProviderResponseError);
});
