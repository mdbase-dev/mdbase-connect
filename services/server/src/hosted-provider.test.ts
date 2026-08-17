import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  CONNECT_CONTRACT_SUPPORT,
  HOSTED_PROVIDER_REQUIRED_CAPABILITIES,
  type ConnectContractSupport
} from "@mdbase-dev/connect-protocol";
import {
  HostedProviderClient,
  HostedProviderResponseError,
  HostedProviderUnavailableError
} from "./hosted-provider.js";

afterEach(() => vi.restoreAllMocks());

function readinessDocument(contractSupport: ConnectContractSupport = CONNECT_CONTRACT_SUPPORT) {
  return {
    status: "ready",
    provider: {
      version: "0.1.0-beta.33",
      capabilities: [...HOSTED_PROVIDER_REQUIRED_CAPABILITIES],
      contract_support: contractSupport
    }
  };
}

describe("hosted provider control client", () => {
  it("activates new Candidate B collections before returning them to the control plane", async () => {
    const legacy = {
      collection_id: "collection",
      execution_model: "legacy",
      pending_execution_model: null,
      head: 0,
      resource_revision: "catalog-v1",
      active_generation_id: null,
      building_generation: null
    };
    const building = {
      ...legacy,
      pending_execution_model: "candidate_b",
      building_generation: {
        collection_id: "collection",
        generation_id: "generation",
        source_head: 0,
        phase: "projection",
        status: "building"
      }
    };
    const active = {
      ...legacy,
      execution_model: "candidate_b",
      active_generation_id: "generation"
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(undefined, { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projection: legacy })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projection: building })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projection: active })));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret",
      newCollectionExecutionModel: "candidate_b"
    });

    await provider.createCollection("account", "collection", "blank", "Notes", "UTC");

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://provider.example/internal/v1/collections", "POST"],
      ["https://provider.example/internal/v1/collections/collection/projection", "GET"],
      [
        "https://provider.example/internal/v1/collections/collection/projection/activate-candidate-b",
        "POST"
      ],
      [
        "https://provider.example/internal/v1/collections/collection/projection/advance",
        "POST"
      ]
    ]);
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({
      expected_head: 0,
      expected_resource_revision: "catalog-v1",
      confirmation: "activate-candidate-b:collection:0:catalog-v1"
    }));
  });

  it("reconciles an activation batch whose successful response was lost", async () => {
    const active = {
      collection_id: "collection",
      execution_model: "candidate_b",
      pending_execution_model: null,
      head: 0,
      resource_revision: "catalog-v1",
      active_generation_id: "generation",
      building_generation: null
    };
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("response lost after commit"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: "projection_generation_not_building",
          message: "The generation completed."
        }
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projection: active })));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret",
      newCollectionExecutionModel: "candidate_b"
    });

    await expect(provider.advanceProjection("collection", "generation"))
      .resolves.toEqual(active);
  });

  it("does not return a completed authority import before Candidate B is active", async () => {
    const completed = {
      id: "transfer",
      collection_id: "collection",
      authority_epoch: 2,
      state: "completed",
      manifest_digest: "sha256:manifest",
      source_revision: "source-v1",
      source_head: 42,
      contracts: [],
      expires_at: "2026-08-18T00:00:00Z"
    };
    const active = {
      collection_id: "collection",
      execution_model: "candidate_b",
      pending_execution_model: null,
      head: 42,
      resource_revision: "catalog-v1",
      active_generation_id: "generation",
      building_generation: null
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(completed)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ projection: active })));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret",
      newCollectionExecutionModel: "candidate_b"
    });

    await expect(provider.completeAuthorityImport(
      "transfer",
      "sha256:manifest",
      "source-v1"
    )).resolves.toEqual(completed);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["https://provider.example/internal/v1/authority-imports/transfer", "POST"],
      ["https://provider.example/internal/v1/collections/collection/projection", "GET"]
    ]);
  });

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
          contract_scope: [],
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

  it("reads authoritative collection storage usage from the provider", async () => {
    const usage = {
      collection_id: "collection",
      record_count: 42,
      content_bytes: 12_345,
      max_records: 100_000,
      max_content_bytes: 1_073_741_824,
      max_document_bytes: 2_097_152,
      file_count: 3,
      file_bytes: 50_000,
      stored_file_bytes: 75_000,
      max_files: 10_000,
      max_file_bytes: 1_073_741_824,
      max_stored_file_bytes: 2_147_483_648,
      max_single_file_bytes: 262_144_000
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ usage }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await expect(provider.collectionUsage("collection")).resolves.toEqual(usage);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/internal/v1/collections/collection/usage",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer internal-secret" }
      })
    );
  });

  it("rejects a successful provider response that omits storage usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await expect(provider.collectionUsage("collection")).rejects.toEqual(
      new HostedProviderResponseError(
        502,
        "invalid_provider_response",
        "Hosted storage usage was missing from the provider response."
      )
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

  it("fails readiness when the provider omits a required durable capability", async () => {
    const document = readinessDocument();
    document.provider.capabilities = ["durable-mutation-journal-v1"];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify(document),
      { status: 200 }
    ));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await expect(provider.ready()).rejects.toBeInstanceOf(HostedProviderUnavailableError);
  });

  it("requires the versioned activation capability only when new Candidate B collections are enabled", async () => {
    const document = readinessDocument();
    document.provider.capabilities = [...HOSTED_PROVIDER_REQUIRED_CAPABILITIES];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify(document),
      { status: 200 }
    ));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret",
      newCollectionExecutionModel: "candidate_b"
    });
    await expect(provider.ready()).rejects.toBeInstanceOf(HostedProviderUnavailableError);
  });

  it("accepts a provider with complete compatibility support and additional future versions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(
      readinessDocument({
        operation_transport: [2, 3],
        authorization_binding: [3, 4, 5],
        semantic_capabilities: [1, 2],
        durable_mutation: [1, 2]
      })
    ), { status: 200 }));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await expect(provider.ready()).resolves.toBeUndefined();
  });

  it("accepts core readiness while durable notification delivery is degraded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ...readinessDocument(),
      notifications: {
        configured: true,
        recovery: "degraded",
        consecutive_failures: 3
      }
    }), { status: 200 }));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });

    await expect(provider.ready()).resolves.toBeUndefined();
  });

  it.each<keyof ConnectContractSupport>([
    "operation_transport",
    "authorization_binding",
    "semantic_capabilities",
    "durable_mutation"
  ])("fails readiness when provider %s support does not intersect", async (axis) => {
    const support = structuredClone(CONNECT_CONTRACT_SUPPORT);
    support[axis] = [99];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify(readinessDocument(support)),
      { status: 200 }
    ));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
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
      contractScope: [],
      fullCollection: false,
      allowedOperations: ["read", "sync", "query"],
      allowedOrigin: "https://tasks.example",
      proofPublicKey: "application-proof-key",
      applicationDeclarationId: "dev.mdbase.tasks",
      applicationDeclarationDigest: `sha256:${"a".repeat(64)}`,
      fileCapability: {
        kind: "files",
        protocol_version: 1,
        actions: ["list", "read"],
        scope: { kind: "selected_folders", folders: ["Assets"] }
      }
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
          contract_scope: [],
          full_collection: false,
          allowed_operations: ["read", "query"],
          file_capability: {
            kind: "files",
            protocol_version: 1,
            actions: ["list", "read"],
            scope: { kind: "selected_folders", folders: ["Assets"] }
          },
          allowed_origin: "https://tasks.example",
          proof_public_key: "application-proof-key",
          application_declaration_id: "dev.mdbase.tasks",
          application_declaration_digest: `sha256:${"a".repeat(64)}`
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
    await provider.createCollection("account", "collection", "mdbase", "Writing", "UTC");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      timezone: "UTC"
    });
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

  it("sends bounded type packs and returns authoritative contract metadata", async () => {
    const contract = {
      id: "workout.record",
      version: "1.0.0",
      digest: `sha256:${"0".repeat(64)}`,
      schema: { type: "object" },
      implementations: [{
        type_name: "workout",
        type_version: 1,
        digest: `sha256:${"1".repeat(64)}`,
        fields: {}
      }]
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
    const document = "---\nkind: mdbase.type\nname: workout\n---\n";
    const provision = {
      manifest: {
        kind: "mdbase.type-pack" as const,
        id: "example.workouts",
        version: "1.0.0",
        resources: [{
          kind: "type" as const,
          mode: "seed" as const,
          source: "workout.md",
          target: "_types/workout.md",
          digest: `sha256:${createHash("sha256").update(document).digest("hex")}`
        }]
      },
      resources: [{ source: "workout.md", document }],
      provides: [{ id: contract.id, version: contract.version, digest: contract.digest }]
    };
    await expect(
      provider.provisionTypePacks("collection", [provision], "example.workouts")
    ).resolves.toEqual({
      contracts: [contract],
      contractSetups: []
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/internal/v1/collections/collection/type-packs/provision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          type_packs: [provision],
          installed_by: "example.workouts"
        })
      })
    );
  });

  it("reads private hosted type candidates and forwards reviewed contract mappings", async () => {
    const candidate = {
      name: "task",
      revision: `sha256:${"2".repeat(64)}`,
      schema: { type: "object", properties: { title: { type: "string" } } },
      extensions: {}
    };
    const setup = {
      contract: {
        id: "example.task",
        version: "1.0.0",
        digest: `sha256:${"3".repeat(64)}`
      },
      mode: "existing" as const,
      type_name: "task",
      type_revision: candidate.revision,
      fields: { title: "title" }
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ types: [candidate] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        contracts: [],
        contract_setups: [setup]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const provider = new HostedProviderClient({
      url: "https://provider.example",
      internalToken: "internal-secret"
    });
    await expect(provider.collectionTypeCandidates("collection")).resolves.toEqual([candidate]);
    await expect(
      provider.provisionTypePacks("collection", [], "example.tasks", [setup])
    ).resolves.toEqual({
      contracts: [],
      contractSetups: [setup]
    });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [
        "https://provider.example/internal/v1/collections/collection/types",
        "GET",
        undefined
      ],
      [
        "https://provider.example/internal/v1/collections/collection/contract-setup",
        "POST",
        JSON.stringify({
          type_packs: [],
          installed_by: "example.tasks",
          contract_setups: [setup]
        })
      ]
    ]);
  });
});
