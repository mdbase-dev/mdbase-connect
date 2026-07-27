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
      publicUrl: "https://sync.example/another-discarded-path",
      internalToken: "internal-secret"
    });
    expect(provider.url).toBe("https://sync.example");
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
          full_collection: false,
          allowed_operations: [],
          token: "replica-secret"
        })
      })
    );
  });

  it("reads payload-free mirror progress from the provider", async () => {
    const status = {
      id: "replica",
      head: 9,
      acknowledged_sequence: 7,
      last_seen_at: "2026-07-23T01:02:03Z",
      token_expires_at: "2026-08-22T01:02:03Z"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ replicas: [status] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await expect(provider.replicaStatuses("collection")).resolves.toEqual([status]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/internal/v1/collections/collection/replicas",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer internal-secret" }
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
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("secret network detail"));
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
      grantId: "grant",
      mode: "read_only",
      allowedTypes: ["task"],
      fullCollection: false,
      allowedOperations: ["read", "query"]
    });
    await provider.rotateReplicaToken("replica", "new-token", 3600);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [
        "https://provider.example/internal/v1/replicas/replica/policy",
        "PATCH",
        JSON.stringify({
          grant_id: "grant",
          mode: "read_only",
          allowed_types: ["task"],
          full_collection: false,
          allowed_operations: ["read", "query"]
        })
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
    await provider.createCollection("collection", "mdbase", "Writing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
  });

  it("propagates collection identity changes to the authority", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(undefined, { status: 204 })
    );
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await provider.renameCollection("collection", "Research notes");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/internal/v1/collections/collection",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ display_name: "Research notes" })
      })
    );
  });

  it("sends bounded type provisions and returns authoritative contract metadata", async () => {
    const contract = {
      id: "workout.record",
      version: 1,
      type_name: "workout",
      extension: "x-workout",
      configuration: { contract: "workout.record", version: 1 }
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ contracts: [contract] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    const provision = {
      name: "Workout",
      document: "---\nkind: mdbase.type\nname: workout\n---\n",
      provides: [{ id: "workout.record", version: 1 }]
    };
    await expect(provider.provisionTypes("collection", [provision])).resolves.toEqual([contract]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/internal/v1/collections/collection/types/provision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ types: [provision] })
      })
    );
  });
});
