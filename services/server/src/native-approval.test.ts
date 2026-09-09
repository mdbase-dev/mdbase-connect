import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityOperationsForContractVersion } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "./db.js";
import { testApplicationAuthorization } from "./application-authorization.test-helper.js";
import { tokenHash, pkceChallenge } from "./security.js";
import { registerAuthorizationRoutes } from "./features/authorizations/routes.js";
import { registerApplicationManifest } from "./manifest.js";
import { canonicalSha256 } from "./canonical-json.js";
import { verifyApplicationAuthorization } from "./application-authorization.js";
import type { RelayHub } from "./relay.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture(version: 1 | 2 = 2, files = false) {
  const db = await createDatabase("memory");
  cleanups.push(() => db.end());
  const userId = randomUUID(), connectorId = randomUUID(), collectionId = randomUUID();
  const authorityId = randomUUID(), applicationId = randomUUID(), requestId = randomUUID();
  const token = randomUUID();
  const operations = capabilityOperationsForContractVersion(version, version === 2 ? "collection.read" : "records.read")!;
  const requestedFiles = files ? { actions: ["list", "read"] as const, scope: { kind: "selected_folders" as const, folders: ["attachments"] } } : undefined;
  const rawRequirements = { ...(files ? { files: { required: ["list", "read"], scope: requestedFiles!.scope } } : {}), contracts: [], access: "full_collection", capabilities: {
    contract_version: version, required: [version === 2 ? "collection.read" : "records.read"]
  } };
  const discovered = registerApplicationManifest({ manifest_version: 1, id: "dev.mdbase.native-test",
    name: "Native test", distribution: "portable", requirements: rawRequirements });
  const requirements = discovered.manifest.requirements;
  const digest = discovered.digest;
  const proof = await testApplicationAuthorization({ applicationId, applicationDeclarationId: "dev.mdbase.native-test",
    applicationManifestDigest: digest, flow: "device_code", authorizationId: requestId,
    codeChallenge: pkceChallenge("native-approval-verifier-000000000000000000000"),
    requestedOperations: operations, semanticCapabilityContractVersion: version, collectionId,
    ...(requestedFiles ? { requestedFiles: { ...requestedFiles, actions: [...requestedFiles.actions] } } : {}) });
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')", [userId, `${userId}@example.test`]);
  await db.query(`INSERT INTO connectors (id, user_id, name, token_hash, relay_public_key)
    VALUES ($1, $2, 'Computer', $3, $4)`, [connectorId, userId, tokenHash(token), proof.binding.grant_agreement_public_key]);
  await db.query(`INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version)
    VALUES ($1, $2, $3, $4, 'Local collection', '0.3.0')`, [authorityId, userId, connectorId, collectionId]);
  await db.query(`INSERT INTO applications (id, canonical_identity, family_identity, manifest_digest,
    distribution, name, homepage, redirect_uris, requirements, provisions, notifications, application_declaration)
    VALUES ($1, $2, 'bundle:dev.mdbase.native-test', $3, 'portable', 'Native test', '', '[]'::jsonb,
    $4::jsonb, '{"type_packs":[],"configuration":[]}'::jsonb, '{"criteria":[]}'::jsonb, $5::jsonb)`,
  [applicationId, `bundle:dev.mdbase.native-test:sha256:${digest}`, digest, JSON.stringify(requirements),
    JSON.stringify(discovered.manifest)]);
  await db.query(`INSERT INTO authorization_requests (id, user_id, application_id, flow, requested_operations,
    collection_id, operation_transport_protocol, application_agreement_public_key, application_signing_public_key,
    application_authorization, application_installation_id, device_origin, expires_at)
    VALUES ($1, $2, $3, 'device_code', $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10, 'null', now() + interval '10 minutes')`,
  [requestId, userId, applicationId, JSON.stringify(operations), collectionId, proof.binding.contracts.operation_transport,
    proof.binding.grant_agreement_public_key, proof.binding.grant_signing_public_key, JSON.stringify(proof), proof.binding.application_installation_id]);
  // Only the transport/daemon is simulated. Route authentication, database
  // binding, planning, activation orchestration, and publication are real.
  const relay = {
    authorizationAuthority: vi.fn(() => "current-daemon-generation"),
    supportsContracts: vi.fn(() => true),
    assertAuthorizationAuthority: vi.fn(async () => {}),
    authorizationOffers: vi.fn(async () => ({ paused: false, collections: [{ collection_id: collectionId }] })),
    activateAuthorization: vi.fn(async (_connector: string, input: Parameters<RelayHub["activateAuthorization"]>[1]) => {
      const grant = input.grant;
      expect(input.authorizationId).toBe(grant.application_authorization.binding.authorization_id);
      expect(canonicalSha256(grant.application_declaration)).toBe(`sha256:${digest}`);
      await verifyApplicationAuthorization(grant.application_authorization, {
        applicationId, applicationDeclarationId: "dev.mdbase.native-test", applicationManifestDigest: digest,
        flow: "device_code", codeChallenge: proof.binding.code_challenge, requestedOperations: operations,
        semanticCapabilityContractVersion: version, collectionId,
        ...(requestedFiles ? { requestedFiles: { ...requestedFiles, actions: [...requestedFiles.actions] } } : {})
      });
      return { contracts: [], contract_setups: [] };
    }),
    pushPolicy: vi.fn(async () => {})
  };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(400).send({ error: String(error) }));
  registerAuthorizationRoutes(app, { db, relay: relay as unknown as RelayHub, publicUrl: "https://connect.example.test", drainProviderRevocations: async () => {} });
  cleanups.push(() => app.close());
  const approve = (payload = { collection_id: collectionId, operations }, credential = token, id = requestId) => app.inject({
    method: "POST", url: `/v1/connectors/authorization-requests/${id}/approve`,
    headers: { authorization: `Bearer ${credential}` }, payload
  });
  return { db, app, relay, approve, proof, userId, connectorId, authorityId, collectionId, requestId, operations, token };
}

it.each([1, 2] as const)("native v%s approval activates and publishes the exact signed grant", async (version) => {
  const f = await fixture(version);
  const response = await f.approve();
  expect(response.statusCode, response.body).toBe(200);
  const grants = (await f.db.query("SELECT * FROM grants")).rows;
  expect(grants).toHaveLength(1);
  expect(grants[0].activated_at).not.toBeNull();
  expect(grants[0].application_authorization).toEqual(f.proof);
  expect(grants[0].operations).toEqual(f.operations);
  expect(grants[0].collection_id).toBe(f.authorityId);
  expect(f.relay.activateAuthorization).toHaveBeenCalledWith(f.connectorId, expect.objectContaining({
    authorizationId: f.requestId, collectionId: f.collectionId, authorityRowId: f.authorityId,
    authorityGeneration: "current-daemon-generation", grant: expect.objectContaining({ application_authorization: f.proof })
  }));
  expect((await f.db.query("SELECT completed_at FROM authorization_requests WHERE id = $1", [f.requestId])).rows[0].completed_at).not.toBeNull();
});

it.each(["unauthenticated", "cross-connector", "cross-user", "expired", "wrong-request", "wrong-collection", "proof-expired", "proof-request", "revoked", "reader-only", "permission-escalation"])(
  "refuses %s before offers, setup, or grants", async (fault) => {
    const f = await fixture();
    let credential = f.token, requestId = f.requestId;
    let collectionId = f.collectionId;
    if (fault === "unauthenticated") credential = "invalid";
    if (fault === "wrong-request") requestId = randomUUID();
    if (fault === "wrong-collection") collectionId = randomUUID();
    if (fault === "cross-connector") {
      const other = randomUUID();
      await f.db.query("INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, 'Other', $3)", [other, f.userId, tokenHash("other")]);
      await f.db.query("UPDATE collections SET connector_id = $2 WHERE id = $1", [f.authorityId, other]);
    }
    if (fault === "cross-user") {
      const other = randomUUID();
      await f.db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Other')", [other, `${other}@example.test`]);
      await f.db.query("UPDATE authorization_requests SET user_id = $2 WHERE id = $1", [f.requestId, other]);
    }
    if (fault === "expired") await f.db.query("UPDATE authorization_requests SET expires_at = now() - interval '1 minute' WHERE id = $1", [f.requestId]);
    if (fault === "revoked") await f.db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [f.connectorId]);
    if (fault === "proof-expired" || fault === "proof-request") {
      const proof = structuredClone(f.proof);
      if (fault === "proof-expired") proof.binding.expires_at = new Date(0).toISOString();
      else proof.binding.authorization_id = randomUUID();
      await f.db.query("UPDATE authorization_requests SET application_authorization = $2::jsonb WHERE id = $1", [f.requestId, JSON.stringify(proof)]);
    }
    if (fault === "reader-only") f.relay.authorizationAuthority.mockImplementation(() => { throw new Error("Selected daemon does not support fresh issuance"); });
    const before = await state(f.db);
    expect((await f.approve({ collection_id: collectionId, operations: fault === "permission-escalation" ? [...f.operations, "delete"] : f.operations }, credential, requestId)).statusCode).toBeGreaterThanOrEqual(400);
    expect(await state(f.db)).toEqual(before);
    expect(f.relay.authorizationOffers).not.toHaveBeenCalled();
    expect(f.relay.activateAuthorization).not.toHaveBeenCalled();
    expect(f.relay.pushPolicy).not.toHaveBeenCalled();
  }
);

it("native denial completes the request without activating it", async () => {
  const f = await fixture();
  const response = await f.app.inject({ method: "POST", url: `/v1/connectors/authorization-requests/${f.requestId}/deny`, headers: { authorization: `Bearer ${f.token}` } });
  expect(response.statusCode).toBe(200);
  expect((await f.approve()).statusCode).toBe(404);
  expect(f.relay.activateAuthorization).not.toHaveBeenCalled();
});

it("native approval preserves signed selected-folder file ceilings", async () => {
  const f = await fixture(2, true);
  const response = await f.approve();
  expect(response.statusCode, response.body).toBe(200);
  const grant = (await f.db.query("SELECT file_capability, application_authorization FROM grants")).rows[0];
  expect(grant.application_authorization).toEqual(f.proof);
  expect(grant.file_capability).toMatchObject({ actions: ["list", "read"], scope: { kind: "selected_folders", folders: ["attachments"] } });
});

it("refuses unsigned file escalation without any effects", async () => {
  const f = await fixture(2, true);
  const before = await state(f.db);
  const response = await f.app.inject({ method: "POST", url: `/v1/connectors/authorization-requests/${f.requestId}/approve`,
    headers: { authorization: `Bearer ${f.token}` }, payload: { collection_id: f.collectionId, operations: f.operations, file_actions: ["list", "read", "delete"] } });
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect(await state(f.db)).toEqual(before);
  expect(f.relay.authorizationOffers).not.toHaveBeenCalled();
  expect(f.relay.activateAuthorization).not.toHaveBeenCalled();
});

async function state(db: DatabasePool) {
  return Promise.all(["authorization_requests", "authorization_collection_offers", "grants"].map(async (table) => (await db.query(`SELECT * FROM ${table}`)).rows));
}
