import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationAuthorizationProof } from "@mdbase-dev/connect-protocol";
import { HostedProviderClient } from "./hosted-provider.js";

afterEach(() => vi.restoreAllMocks());
const client = () => new HostedProviderClient({ url: "https://provider.example", internalToken: "test" });
const declaration = { id: "dev.mdbase.fixture", requirements: { capabilities: { contract_version: 2 } }, extension: { unchanged: true } };
const proof = (version: number) => ({ binding: { contracts: { semantic_capabilities: version } }, signature: "retained-approved-proof" }) as ApplicationAuthorizationProof;
const policy = (version = 2) => ({
  grantId: "grant", mode: "read_only" as const, allowedTypes: [], contractScope: [], fullCollection: true,
  allowedOperations: ["assess_collection_setup"], operationTransportProtocol: 3,
  operationTransportRecoveryProtocols: [2], allowedOrigin: "null", proofPublicKey: "key",
  applicationDeclarationId: declaration.id, applicationDeclarationDigest: "sha256:bound",
  applicationDeclaration: declaration, applicationAuthorization: proof(version)
});

it("transports retained full evidence on v2 registration and policy restoration only after explicit support", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/ready")
    ? new Response(JSON.stringify({ status: "ready", provider: { capabilities: ["application-setup-evidence-v2"] } }))
    : new Response(null, { status: 204 }));
  const provider = client();
  await provider.registerReplica("collection", { ...policy(), id: "replica", name: "test", purpose: "application", token: "token" });
  await provider.updateApplicationReplica("replica", policy());
  const writes = fetch.mock.calls.filter(([, init]) => init?.method !== "GET");
  expect(writes).toHaveLength(2);
  for (const [url, init] of writes) {
    expect(String(url)).toContain("/internal/v2/");
    expect(JSON.parse(String(init?.body)).application_setup_evidence).toEqual({
      application_declaration: declaration, application_authorization: proof(2)
    });
  }
});

it("does not send new fields or readiness probes in semantic-v1 policy bodies", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  await client().updateApplicationReplica("replica", { ...policy(1), applicationDeclaration: undefined });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/internal/v1/");
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty("application_setup_evidence");
});

it("does not fall back to a v1 write if readiness and policy hit different provider versions", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).endsWith("/ready")
    ? new Response(JSON.stringify({ status: "ready", provider: { capabilities: ["application-setup-evidence-v2"] } }))
    : new Response(null, { status: 404 }));
  await expect(client().updateApplicationReplica("replica", policy())).rejects.toThrow();
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://provider.example/ready", "https://provider.example/internal/v2/replicas/replica/policy"
  ]);
});

it("fails closed without v2 declaration or explicit provider enforcement capability", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "ready", provider: { capabilities: [] } })));
  await expect(client().updateApplicationReplica("replica", { ...policy(), applicationDeclaration: undefined })).rejects.toThrow();
  await expect(client().updateApplicationReplica("replica", { ...policy(), applicationAuthorization: undefined })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(client().updateApplicationReplica("replica", policy())).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
});
