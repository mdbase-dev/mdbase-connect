import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredToken } from "./internal-types.js";
import {
  performHostedFilePartRequest,
  performHostedFileRequest
} from "./hosted-file-request.js";
import { createRequestBudget, requestAbortReason } from "./request-budget.js";

const token = {
  authority: {
    accessToken: "authority-token",
    filesUrl: "https://provider.example/v1/authorities/collection/files"
  },
  fileCapability: { kind: "files" }
} as StoredToken;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("hosted file responses", () => {
  it("retains a refreshed grant before retrying the hosted request", async () => {
    const refreshed = {
      ...token,
      refreshToken: "rotated-refresh",
      keyHandle: "rotated-key",
      authority: { ...token.authority!, accessToken: "rotated-authority-token" }
    } as StoredToken;
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    let finishRetaining!: () => void;
    const retained = vi.fn(() => new Promise<StoredToken>((resolve) => {
      finishRetaining = () => resolve(refreshed);
    }));

    const request = performHostedFileRequest(
      { ...token, refreshToken: "refresh" },
      "GET",
      "",
      undefined,
      undefined,
      async () => refreshed,
      async () => ({}),
      retained
    );
    await vi.waitFor(() => expect(retained).toHaveBeenCalledWith(refreshed));
    expect(fetch).toHaveBeenCalledOnce();

    finishRetaining();
    await expect(request).resolves.toEqual({ files: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1]![1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer rotated-authority-token");
  });

  for (const path of ["control", "part"] as const) {
    for (const interruption of ["abort", "timeout"] as const) {
      it(`passes the active ${interruption} signal through ${path} refresh`, async () => {
        if (interruption === "timeout") vi.useFakeTimers();
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 401 }));
        const refresh = vi.fn((signal?: AbortSignal) => new Promise<StoredToken>((_resolve, reject) => {
          const abort = () => reject(requestAbortReason(signal!));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }));
        const controller = new AbortController();
        const budget = interruption === "timeout"
          ? createRequestBudget({ timeoutMs: 5 })
          : null;
        const signal = budget?.signal ?? controller.signal;
        const request = path === "control"
          ? performHostedFileRequest(
              { ...token, refreshToken: "refresh" },
              "GET", "", undefined, signal, refresh, async () => ({})
            )
          : performHostedFilePartRequest(
              { ...token, refreshToken: "refresh" },
              "downloads/transfer/parts/0", 1, signal, refresh, async () => ({})
            );
        const rejection = expect(request).rejects.toMatchObject({
          code: interruption === "timeout" ? "timeout" : "operation_cancelled"
        });
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith(signal));

        if (interruption === "timeout") await vi.advanceTimersByTimeAsync(5);
        else controller.abort("caller left");

        await rejection;
        budget?.dispose();
      });
    }
  }

  it("returns the response stream without buffering it", async () => {
    const first = Uint8Array.of(1, 2);
    const second = Uint8Array.of(3, 4, 5);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(first);
          controller.enqueue(second);
          controller.close();
        }
      }),
      { headers: { "content-length": "5" } }
    ));

    const stream = await performHostedFilePartRequest(
      token,
      "downloads/transfer/parts/0",
      5,
      undefined,
      async () => token,
      async () => ({})
    );
    const reader = stream.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: first });
    await expect(reader.read()).resolves.toEqual({ done: false, value: second });
  });

  it("rejects a missing or mismatched content length before exposing bytes", async () => {
    let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(1));
        },
        cancel() {
          cancelled = true;
        }
      })
    ));

    await expect(performHostedFilePartRequest(
      token,
      "downloads/transfer/parts/0",
      1,
      undefined,
      async () => token,
      async () => ({})
    )).rejects.toMatchObject({ code: "invalid_operation_response" });
    expect(cancelled).toBe(true);
  });
});
