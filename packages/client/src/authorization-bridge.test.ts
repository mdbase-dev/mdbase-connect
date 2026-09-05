import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationAuthorizationProof, CollectionOperation, LegacyMdbaseAppManifest, MdbaseAppManifest as V2Manifest } from "@mdbase-dev/connect-protocol";
import { MdbaseConnect, MdbaseMemorySelection, type MdbaseAppManifest } from "./index.js";
import { MdbaseSession } from "./session.js";
import { MemoryStorage } from "./runtime-utils.js";
import { MemoryGrantKeyStore } from "./crypto.js";
import { MemoryApplicationIdentityStore } from "./application-identity.js";
import { effectiveCapabilities } from "./capabilities.js";
import { authorizationFiles, authorizationOperations } from "./application-contract.js";

const collectionId = "00000000-0000-0000-0000-000000000002";
const applicationId = "00000000-0000-0000-0000-000000000001";
const serverUrl = "https://connect.example";
const prefix = `${serverUrl}:bundle:dev.bridge.test`;
function manifest(version: 1): LegacyMdbaseAppManifest;
function manifest(version: 2): V2Manifest;
function manifest(version: 1 | 2): MdbaseAppManifest;
function manifest(version: 1 | 2): MdbaseAppManifest {
  const base = {
    manifest_version: 1 as const, id: "dev.bridge.test", name: "Bridge test",
    homepage: "https://bridge.example/", redirect_uris: ["https://bridge.example/callback"]
  };
  if (version === 1) return { ...base, requirements: {
    contracts: [], access: "full_collection",
    capabilities: { contract_version: 1, required: ["records.query"], optional: ["records.update", "records.create"] },
    files: { actions: ["read", "replace"], scope: { kind: "collection" } }
  } };
  return { ...base, requirements: {
    contracts: [], access: "full_collection",
    capabilities: { contract_version: 2, required: ["collection.read"], optional: ["records.edit", "records.create"] },
    files: { required: ["read"], optional: ["replace"], scope: { kind: "collection" } }
  } };
}

function fixture(declaration: MdbaseAppManifest = manifest(1), operations: CollectionOperation[] = ["query"]) {
  const storage = new MemoryStorage();
  const keyStore = new MemoryGrantKeyStore();
  const identityStore = new MemoryApplicationIdentityStore();
  const proofs: ApplicationAuthorizationProof[] = [];
  const navigate = vi.fn();
  storage.setItem(`mdbase-connect:${prefix}:token:${collectionId}`, JSON.stringify({
    version: 1, accessToken: "test-token", clientId: applicationId, collectionId,
    collectionName: "Bridge collection", operations,
    scope: { contracts: [], access: "full_collection" }, expiresAt: Date.now() + 60_000, savedAt: Date.now()
  }));
  storage.setItem(`mdbase-connect:${prefix}:connections`, JSON.stringify({ version: 1, collectionIds: [collectionId] }));
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    if (String(request).endsWith("/v1/apps/register")) return Response.json({ application: {
      id: applicationId, family_identity: `bundle:${declaration.id}`, manifest_digest: "a".repeat(64),
      name: declaration.name, requirements: declaration.requirements, distribution: declaration.distribution
    } });
    const form = new URLSearchParams(String(init?.body));
    const proof: ApplicationAuthorizationProof = JSON.parse(form.get("application_authorization")!);
    proofs.push(proof);
    if (String(request).endsWith("/oauth/device_authorization")) return Response.json({
      device_code: "test-device-code", user_code: "TEST-CODE", verification_uri: "https://connect.example/device",
      verification_uri_complete: "https://connect.example/device?user_code=TEST-CODE", expires_in: 600, interval: 1
    });
    return Response.json({
      authorization_id: proof.binding.authorization_id,
      authorization_uri: `https://connect.example/oauth/authorize?request_id=${proof.binding.authorization_id}`,
      expires_in: 600
    });
  });
  const manager = () => new MdbaseConnect({
    serverUrl, manifest: declaration, redirectUri: "https://bridge.example/callback",
    storage, keyStore, identityStore, navigate, relayEncryption: declaration.distribution === "portable" ? "required" : "disabled"
  });
  return { manager, storage, keyStore, proofs, navigate, fetch };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("SDK authorization semantic bridge", () => {
  it("signs exact legacy independent operations and files as semantic v1", async () => {
    const test = fixture();
    expect(await test.manager().authorize({ operations: ["update", "query", "update"] })).toMatchObject({ ok: true });
    expect(test.proofs[0].binding).toMatchObject({
      application_manifest_digest: "a".repeat(64),
      requested_operations: ["update", "query"],
      requested_files: { actions: ["read", "replace"], scope: { kind: "collection" } },
      contracts: { semantic_capabilities: 1, durable_mutation: 1 }
    });
    expect(test.proofs[0].binding.requested_operations).not.toContain("rename");
  });

  it("uses predecessor defaults even when a legacy capability declaration exists", async () => {
    const test = fixture();
    await test.manager().authorize();
    expect(test.proofs[0].binding.requested_operations).toEqual(["describe", "changes", "read", "query"]);
    const noCapabilities = manifest(1);
    delete noCapabilities.requirements.capabilities;
    expect(authorizationOperations(noCapabilities, {})).toEqual(["describe", "changes", "read", "query"]);
  });

  it.each([1, 2] as const)("rejects mixed options for v%s without signing or navigation", async (version) => {
    const test = fixture(manifest(version));
    expect(await test.manager().authorize({ operations: ["query"], capabilities: [] })).toMatchObject({
      ok: false, problem: { code: "invalid_application_manifest" }
    });
    expect(test.proofs).toEqual([]);
    expect(test.navigate).not.toHaveBeenCalled();
  });

  it("rejects all legacy operations entry points on v2, including sufficient empty requests", async () => {
    const test = fixture(manifest(2));
    const manager = test.manager();
    const connection = manager.connection(collectionId)!;
    const session = new MdbaseSession(manager, { selection: new MdbaseMemorySelection() });
    await session.start();
    const applicationSession = manager.application({ selection: new MdbaseMemorySelection() });
    await applicationSession.start();
    for (const outcome of [
      await manager.authorize({ operations: [] }),
      await connection.authorize({ operations: ["query"] }),
      await connection.requestOperations([]),
      await session.ensureOperations([]),
      await applicationSession.ensureOperations([])
    ]) expect(outcome).toMatchObject({ ok: false, problem: { code: "invalid_application_manifest" } });
    expect(test.proofs).toEqual([]);
    session.destroy();
    applicationSession.destroy();
  });

  it("restores legacy grants unchanged and preserves independent operations incrementally", async () => {
    const test = fixture(manifest(1), ["query", "delete"]);
    const connection = test.manager().connection(collectionId)!;
    expect(connection.operations).toEqual(["query", "delete"]);
    expect(await connection.requestOperations(["query"])).toMatchObject({ ok: true, value: { kind: "unchanged" } });
    await connection.requestOperations(["update"]);
    expect(test.proofs[0].binding.requested_operations).toEqual(["query", "delete", "update"]);
    const restored = test.manager().connection(collectionId)!;
    expect(restored.operations).toEqual(["query", "delete"]);
    await restored.requestCapabilities(["records.update"]);
    expect(test.proofs[1].binding.requested_operations).toEqual(["query", "delete", "update"]);
    expect(test.proofs.every((proof) => proof.binding.contracts.semantic_capabilities === 1)).toBe(true);
  });

  it("restores legacy application readiness and exact session defaults/incremental requests", async () => {
    const test = fixture();
    const session = test.manager().application({ selection: new MdbaseMemorySelection() });
    expect(await session.start()).toMatchObject({ ok: true });
    expect(session.getSnapshot()).toMatchObject({ status: "ready", capabilities: {
      contractVersion: 1, requiredAvailable: true, values: { "records.query": { state: "available", operations: ["query"] } }
    } });
    await session.authorize("selected");
    expect(test.proofs[0].binding.requested_operations).toEqual(["query", "update", "create"]);
    await session.ensureOperations(["update"]);
    expect(test.proofs[1].binding.requested_operations).toEqual(["query", "update"]);
    await session.ensureCapabilities(["records.update"]);
    expect(test.proofs[2].binding.requested_operations).toEqual(["query", "update"]);
    session.destroy();
  });

  it("keeps v2 grouping/signing/files and incremental selected groups unchanged", async () => {
    const declaration = manifest(2);
    const required = authorizationOperations(declaration, { capabilities: ["records.create"] });
    const test = fixture(declaration, required);
    await test.manager().connection(collectionId)!.requestCapabilities(["records.edit"]);
    expect(test.proofs[0].binding).toMatchObject({
      contracts: { semantic_capabilities: 2 }, requested_operations: [...required, "update", "rename"],
      requested_files: { actions: ["read", "replace"] }
    });
    expect(authorizationFiles(manifest(1).requirements)).toEqual(authorizationFiles(declaration.requirements));
  });

  it("signs legacy portable device authorization as semantic v1 without broadening", async () => {
    const test = fixture({
      manifest_version: 1, distribution: "portable", id: "dev.bridge.test", name: "Portable bridge",
      project_url: "https://bridge.example", requirements: manifest(1).requirements
    });
    const controller = new AbortController();
    const result = await test.manager().authorize({
      operations: ["update"], signal: controller.signal,
      onDeviceCode: () => controller.abort(), openVerification: () => undefined
    });
    expect(result).toMatchObject({ ok: false });
    expect(test.proofs).toHaveLength(1);
    expect(test.proofs[0].binding).toMatchObject({ flow: "device_code", requested_operations: ["update"], contracts: { semantic_capabilities: 1 } });
  });

  it("preserves exact pending mutation evidence while adding signed legacy recovery transport", async () => {
    const test = fixture();
    const pendingKey = `mdbase-connect:${prefix}:pending-mutation:${collectionId}:pending-request`;
    const pending = JSON.stringify({
      collectionId, operation: "update", requestId: "pending-request", inputFingerprint: "unchanged-digest",
      envelope: { protocol_version: 2, ciphertext: "opaque-existing-ciphertext" }
    });
    test.storage.setItem(pendingKey, pending);
    await test.manager().connection(collectionId)!.requestOperations(["update"]);
    expect(test.proofs[0].binding.contracts).toMatchObject({ semantic_capabilities: 1, operation_transport_recovery: [2] });
    test.manager().connection(collectionId);
    expect(test.storage.getItem(pendingKey)).toBe(pending);
    expect(test.proofs[0].binding.application_manifest_digest).toBe("a".repeat(64));
  });

  it("restores legacy file and notification readiness without assigning those aliases to v2", () => {
    const test = fixture();
    const info = test.manager().connection(collectionId)!.info()!;
    const declaration = manifest(1);
    const requirements = { contract_version: 1 as const, required: ["files.read", "notifications.background-delivery"] as const };
    const capabilities = effectiveCapabilities({ ...requirements, required: [...requirements.required] }, declaration, info);
    expect(capabilities.values["files.read"]?.state).toBe("unsupported");
    expect(capabilities.values["notifications.background-delivery"]?.state).toBe("requires_setup");
    expect(capabilities.requiredAvailable).toBe(false);
    const granted = effectiveCapabilities({ contract_version: 1, required: ["files.read"] }, declaration, {
      ...info, fileCapability: { kind: "files", protocol_version: 1, actions: ["read"], scope: { kind: "collection" } }
    });
    expect(granted.requiredAvailable).toBe(true);
  });

  it("does not retry a rejected v2 request as v1", async () => {
    const test = fixture(manifest(2));
    const implementation = test.fetch.getMockImplementation()!;
    test.fetch.mockImplementation(async (request, init) => {
      const response = await implementation(request, init);
      return String(request).endsWith("/v1/apps/register") ? response : Response.json({ error: "unsupported_contract" }, { status: 409 });
    });
    expect(await test.manager().authorize()).toMatchObject({ ok: false });
    expect(test.proofs).toHaveLength(1);
    expect(test.proofs[0].binding.contracts.semantic_capabilities).toBe(2);
    expect(test.navigate).not.toHaveBeenCalled();
  });

  it("rejects mixed incremental JS options before sufficient-grant shortcuts", async () => {
    const test = fixture();
    const connection = test.manager().connection(collectionId)!;
    expect(await connection.requestOperations(["query"], { capabilities: [] })).toMatchObject({ ok: false });
    expect(await connection.requestCapabilities(["records.query"], { operations: [] })).toMatchObject({ ok: false });
    const session = test.manager().application({ selection: new MdbaseMemorySelection() });
    await session.start();
    const mixedOptions = { timeoutMs: 1000, operations: [] };
    expect(await session.ensureCapabilities(["records.query"], mixedOptions)).toMatchObject({ ok: false });
    expect(test.proofs).toEqual([]);
    session.destroy();
  });
});
