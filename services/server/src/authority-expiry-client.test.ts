import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedProviderClient } from "./hosted-provider.js";
import { AuthorityTransferRecoveryWorker } from "./features/authority-transfer/recovery-worker.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("explicit provider expiry acknowledgements", () => {
  it.each(["import", "transfer"])("requires the exact %s binding and never uses ordinary cancellation on old providers", async (kind) => {
    const provider = new HostedProviderClient({ url: "https://provider.example", internalToken: "test-internal" });
    const expected = kind === "import"
      ? { transfer_id: "transfer", collection_id: "collection", authority_epoch: 2, expired: true }
      : { id: "transfer", collection_id: "collection", authority_epoch: 2, state: "aborted" };
    const expire = () => kind === "import"
      ? provider.expireAuthorityImport("transfer", "collection", 2)
      : provider.expireAuthorityTransfer("transfer", "collection", 2);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    for (const body of [{}, { ...expected, collection_id: "other" }, { ...expected, authority_epoch: 3 },
      { ...expected, ...(kind === "import" ? { expired: false } : { state: "completed" }) },
      { ...expected, ...(kind === "import" ? { transfer_id: "other" } : { id: "other" }) }]) {
      fetchMock.mockResolvedValueOnce(Response.json(body));
      await expect(expire()).rejects.toThrow();
    }
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: "not_found", message: "[test] Old provider" } }, { status: 404 }));
    await expect(expire()).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(Response.json(expected));
    await expect(expire()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls).toHaveLength(7);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`https://provider.example/internal/v1/authority-${kind === "import" ? "imports" : "transfers"}/transfer/expire`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ collection_id: "collection", authority_epoch: 2 }));
    }
  });
});

describe("bounded background recovery scheduler", () => {
  it("does not overlap passes or start another pass during shutdown", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const recover = vi.fn(() => pending.promise);
    const worker = new AuthorityTransferRecoveryWorker(recover, vi.fn());
    worker.start();
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(recover).toHaveBeenCalledTimes(1);
    let closed = false;
    const close = worker.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(closed).toBe(false);
    pending.resolve();
    await close;
    await worker.drainOnce();
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("reports a failed pass and retries at the next bounded interval", async () => {
    vi.useFakeTimers();
    const error = new Error("[test] Uncertain provider result");
    const recover = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const worker = new AuthorityTransferRecoveryWorker(recover, onError);
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onError).toHaveBeenCalledWith(error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recover).toHaveBeenCalledTimes(2);
    } finally { await worker.close(); }
  });
});
