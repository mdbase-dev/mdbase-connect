import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostedProviderClient,
  HostedProviderResponseError,
  HostedProviderUnavailableError
} from "./hosted-provider.js";

afterEach(() => vi.restoreAllMocks());

describe("hosted provider control client", () => {
  it("uses only the internal bearer credential and expected provider document", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(undefined, { status: 201 })
    );
    const provider = new HostedProviderClient({
      url: "https://provider.example/path-is-discarded",
      internalToken: "internal-secret"
    });
    await provider.registerReplica("collection", {
      id: "replica",
      name: "Laptop",
      mode: "read_only",
      allowedTypes: ["task"],
      token: "replica-secret"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/internal/v1/collections/collection/replicas",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer internal-secret",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          replica_id: "replica",
          name: "Laptop",
          purpose: "mirror",
          mode: "read_only",
          allowed_types: ["task"],
          allowed_operations: [],
          token: "replica-secret"
        })
      })
    );
  });

  it("preserves safe provider errors and normalizes network failures", async () => {
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: "replica_conflict", message: "Replica already exists." }
    }), { status: 409 }));
    await expect(provider.revokeReplica("replica")).rejects.toEqual(
      new HostedProviderResponseError(409, "replica_conflict", "Replica already exists.")
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("secret network detail"));
    await expect(provider.ready()).rejects.toBeInstanceOf(HostedProviderUnavailableError);
  });

  it("updates and rotates application capabilities with bounded credentials", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(undefined, { status: 204 })
    );
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await provider.updateApplicationReplica("replica", {
      mode: "read_only",
      allowedOperations: ["read", "query"]
    });
    await provider.rotateReplicaToken("replica", "new-token", 3600);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [
        "https://provider.example/internal/v1/replicas/replica/policy",
        "PATCH",
        JSON.stringify({ mode: "read_only", allowed_operations: ["read", "query"] })
      ],
      [
        "https://provider.example/internal/v1/replicas/replica/token",
        "POST",
        JSON.stringify({ token: "new-token", token_ttl_seconds: 3600 })
      ]
    ]);
  });

  it("retries bounded transient failures with the identical provisioning document", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(new Response(undefined, { status: 201 }));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await provider.createCollection("collection", "tasknotes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
  });
});
