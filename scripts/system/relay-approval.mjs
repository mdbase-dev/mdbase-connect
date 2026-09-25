import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { APPLICATION_AUTHORIZATION_PROTOCOL_VERSION, authorizationContractRequirements,
  capabilityOperationsForContractVersion } from "../../packages/protocol/dist/index.js";
import { applicationInstallationId, MemoryGrantKeyStore, signApplicationAuthorization } from "../../packages/client/dist/crypto-entry.js";
import { registerApplicationManifest } from "../../services/server/dist/manifest.js";

/** Fresh approval, not a preinstalled grant: real PostgreSQL and NATS owners. */
export async function freshRelayApproval({ db, appA, appB, fixture, activations }) {
  const declaration = registerApplicationManifest({ manifest_version: 1,
    id: "dev.mdbase.relay-approval", name: "Relay approval", distribution: "portable",
    requirements: { contracts: [], access: "full_collection",
      capabilities: { contract_version: 2, required: ["collection.read"] } } });
  const applicationId = randomUUID();
  const operations = capabilityOperationsForContractVersion(2, "collection.read");
  await db.query(`INSERT INTO applications (id, canonical_identity, family_identity, manifest_digest,
    distribution, name, homepage, redirect_uris, requirements, provisions, notifications, application_declaration)
    VALUES ($1, $2, 'bundle:dev.mdbase.relay-approval', $3, 'portable', 'Relay approval', '', '[]'::jsonb,
      $4::jsonb, '{"type_packs":[],"configuration":[]}'::jsonb, '{"criteria":[]}'::jsonb, $5::jsonb)`,
  [applicationId, `bundle:dev.mdbase.relay-approval:sha256:${declaration.digest}`, declaration.digest,
    JSON.stringify(declaration.manifest.requirements), JSON.stringify(declaration.manifest)]);
  await db.query("UPDATE connectors SET relay_public_key = $2 WHERE id = $1", [fixture.connectorId, fixture.connectorAgreementPublicKey]);
  const login = await appB.inject({ method: "POST", url: "/v1/dev/session", payload: { email: "relay-e2e@example.com", name: "Relay E2E" } });
  assert.equal(login.statusCode, 200, login.body);
  const cookies = login.headers["set-cookie"];
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies).split(";")[0];
  const keys = new MemoryGrantKeyStore();
  const installation = await keys.create(`approval-installation:${applicationId}`);
  for (const source of ["portal", "connector"]) {
    for (const [name, app] of [["owner", appA], ["non-owner", appB]]) {
      const id = randomUUID();
      const grantKey = await keys.create(`approval-grant:${id}`);
      const issued = new Date();
      const proof = await signApplicationAuthorization({
        protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
        authorization_id: id, application_id: applicationId,
        application_declaration_id: declaration.manifest.id, application_manifest_digest: declaration.digest,
        application_installation_id: await applicationInstallationId(installation),
        installation_signing_public_key: installation.signingPublicKey,
        grant_agreement_public_key: grantKey.agreementPublicKey, grant_signing_public_key: grantKey.signingPublicKey,
        flow: "device_code", authorization_nonce: randomBytes(32).toString("base64url"),
        issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 600_000).toISOString(),
        code_challenge: randomBytes(32).toString("base64url"),
        contracts: authorizationContractRequirements(operations), requested_operations: operations,
        collection_id: fixture.localCollectionId
      }, installation);
      await db.query(`INSERT INTO authorization_requests (id, user_id, application_id, flow, requested_operations,
        collection_id, operation_transport_protocol, application_agreement_public_key, application_signing_public_key,
        application_authorization, application_installation_id, device_origin, expires_at)
        VALUES ($1, $2, $3, 'device_code', $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10, 'null', now() + interval '10 minutes')`,
      [id, fixture.userId, applicationId, JSON.stringify(operations), fixture.localCollectionId,
        proof.binding.contracts.operation_transport, proof.binding.grant_agreement_public_key,
        proof.binding.grant_signing_public_key, JSON.stringify(proof), proof.binding.application_installation_id]);
      let offerId;
      if (source === "portal") {
        const discovery = await app.inject({ method: "GET", url: `/v1/authorization-requests/${id}`, headers: { cookie } });
        assert.equal(discovery.statusCode, 200, discovery.body);
        const collection = discovery.json().collections.find((candidate) => candidate.id === fixture.localCollectionId);
        assert.ok(collection, `${name} could not discover a live collection`);
        offerId = collection.offer_id;
      }
      const before = activations.length;
      const response = await app.inject({ method: "POST",
        url: `/v1/${source === "connector" ? "connectors/" : ""}authorization-requests/${id}/approve`,
        headers: source === "connector" ? { authorization: `Bearer ${fixture.connectorToken}` } : { cookie },
        payload: { collection_id: fixture.localCollectionId, ...(offerId ? { offer_id: offerId } : {}), operations, contract_setups: [] } });
      assert.equal(response.statusCode, 200, `${source} approval on ${name}: ${response.body}`);
      assert.equal(activations.length, before + 1);
      assert.deepEqual(activations.at(-1).application_authorization, proof);
      assert.equal(activations.at(-1).application_origin, "null");
      const publication = await db.query(`SELECT ar.completed_at, g.activated_at FROM authorization_requests ar
        JOIN grants g ON g.id = ar.grant_id WHERE ar.id = $1`, [id]);
      assert.ok(publication.rows[0]?.completed_at && publication.rows[0]?.activated_at, `${source} approval was not published`);
    }
  }
  process.stdout.write("fresh portal and desktop approval passed on both NATS instances\n");
}
