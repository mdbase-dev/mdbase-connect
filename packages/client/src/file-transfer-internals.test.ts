import { afterEach, describe, expect, it, vi } from "vitest";
import { connectError } from "./errors.js";
import { retryChunk } from "./file-transfer-internals.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("file transfer transient retries", () => {
  it("backs off retryable availability failures long enough to bridge a restart", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const work = vi.fn()
      .mockRejectedValueOnce(connectError("connector_busy", "Busy."))
      .mockRejectedValueOnce(connectError("connector_offline", "Offline."))
      .mockResolvedValue(new Uint8Array([1, 2, 3]));

    const result = retryChunk(work);
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(work).toHaveBeenCalledTimes(3);
  });

  it("never retries a canonical non-retryable failure", async () => {
    const work = vi.fn().mockRejectedValue(connectError(
      "invalid_operation_response",
      "Invalid response."
    ));

    await expect(retryChunk(work)).rejects.toMatchObject({
      code: "invalid_operation_response"
    });
    expect(work).toHaveBeenCalledOnce();
  });
});
