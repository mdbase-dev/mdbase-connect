import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredToken } from "./internal-types.js";
import { performHostedFilePartRequest } from "./hosted-file-request.js";

const token = {
  authority: {
    accessToken: "authority-token",
    filesUrl: "https://provider.example/v1/authorities/collection/files"
  },
  fileCapability: { kind: "files" }
} as StoredToken;

afterEach(() => vi.restoreAllMocks());

describe("hosted file responses", () => {
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
