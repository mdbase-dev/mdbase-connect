import { describe, expect, it, vi } from "vitest";
import { collectionModeExecutionAvailable } from "./collection-mode-execution.js";
import type { NextControlPlaneConfig } from "./policy-keys.js";

const next = {
  privateBootstrap: true,
  cloudCopyBootstrap: { hosted: { url: "https://hosted.test", token: "public-hosted-fixture".repeat(3) },
    escrow: { url: "https://escrow.test", token: "public-escrow-fixture".repeat(3) } },
} as NextControlPlaneConfig;

describe("collection mode release gate", () => {
  it("does not advertise execution merely because both bootstraps are configured", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await collectionModeExecutionAvailable(next, fetch)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([404, 401, 500])("stays disabled when a configured Worker lacks the authenticated mode handler (%s)", async status => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not found", { status }));
    expect(await collectionModeExecutionAvailable({ ...next, collectionModeExecution: true }, fetch)).toBe(false);
  });
  it("requires both existing Worker endpoints before mounting execution", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      expect(new URL(String(url)).pathname).toMatch(/^\/internal\/v1\/collection-mode\/(?:ready|retire)$/u);
      expect(init?.body).toBe("{}"); // Invalid request: no actor, key, admission or storage effect.
      return Response.json({ error: "not_ready" }, { status: 503 });
    });
    expect(await collectionModeExecutionAvailable({ ...next, collectionModeExecution: true }, fetch)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("refuses a Worker that has ready but lacks retire", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => String(url).endsWith("/retire")
      ? new Response("missing", { status: 404 }) : Response.json({ error: "not_ready" }, { status: 503 }));
    expect(await collectionModeExecutionAvailable({ ...next, collectionModeExecution: true }, fetch)).toBe(false);
  });
  it("refuses a malformed or oversized availability answer", async () => {
    for (const body of ["{}", "x".repeat(1024)]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(body, { status: 503 }));
      expect(await collectionModeExecutionAvailable({ ...next, collectionModeExecution: true }, fetch)).toBe(false);
    }
  });
});
