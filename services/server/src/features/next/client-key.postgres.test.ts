import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApplicationAuthorization } from "../../application-authorization.test-helper.js";
import { ApplicationAuthorizationError } from "../../application-authorization.js";
import { capabilityOperations } from "@mdbase-dev/connect-protocol";
import { buildApp } from "../../app.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerApplicationManifest } from "../../manifest.js";
import { certToJson, ed25519RawPublicKey } from "./policy-keys.js";
import { certDigest, keyId } from "./policy-wire.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { buildPolicySnapshot, type LeasePolicySnapshot } from "../../relay-policy.js";
import { pkceChallenge } from "../../security.js";
import { clientNoiseKeyMessage, copyClientNoiseKeyToGrant, storeRequestClientNoiseKey, verifiedClientNoiseKey, withClientFingerprint } from "./client-key.js";
import { clientFingerprint } from "./devices.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

function grantSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.of(4), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { privateKey, publicKey: raw.toString("base64url") };
}

async function proofWith(signingPublicKey: string) {
  return testApplicationAuthorization({
    applicationId: randomUUID(), applicationDeclarationId: "dev.mdbase.client-key-test",
    applicationManifestDigest: "a".repeat(64), flow: "device_code",
    codeChallenge: pkceChallenge("client-key-verifier-00000000000000000000000000"),
    requestedOperations: ["read"], semanticCapabilityContractVersion: 2,
    grantSigningPublicKey: signingPublicKey
  });
}

function attestation(key: ReturnType<typeof grantSigningKey>, authorizationId: string, publicKey = randomBytes(32)) {
  const signature = sign("sha256", clientNoiseKeyMessage(authorizationId, publicKey), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return { publicKey, raw: JSON.stringify({ public_key: publicKey.toString("base64url"), signature: signature.toString("base64url") }) };
}

describe("client Noise key attestation", () => {
  it("shows the portal a fingerprint, never the raw key", () => {
    const key = randomBytes(32);
    expect(withClientFingerprint({ id: "r", client_pk: key })).toEqual({ id: "r", client_fingerprint: clientFingerprint(key) });
    expect(withClientFingerprint({ id: "r", client_pk: null })).toEqual({ id: "r", client_fingerprint: null });
    expect(withClientFingerprint({ id: "r", client_pk: Buffer.alloc(32) }))
      .toEqual({ id: "r", client_fingerprint: "535b-c237-63ed-cd6a" });
  });

  it("pins the attested message bytes", () => {
    const message = clientNoiseKeyMessage("4c18af2e-b04a-4b77-b83e-493c3695962e", Buffer.alloc(32, 0x0c));
    expect(message.toString("hex")).toBe(
      Buffer.from("mdbase-next client noise key v1\0").toString("hex")
      + "00000010" + "4c18af2eb04a4b77b83e493c3695962e"
      + "00000020" + "0c".repeat(32)
    );
  });

  it("accepts a key signed by the binding's grant signing key and nothing else", async () => {
    const key = grantSigningKey();
    const { binding } = await proofWith(key.publicKey);
    const good = attestation(key, binding.authorization_id);
    expect(verifiedClientNoiseKey(good.raw, binding)?.publicKey.equals(good.publicKey)).toBe(true);
    expect(verifiedClientNoiseKey(undefined, binding)).toBeUndefined();

    const otherSigner = attestation(grantSigningKey(), binding.authorization_id);
    expect(() => verifiedClientNoiseKey(otherSigner.raw, binding)).toThrow(ApplicationAuthorizationError);
    const otherAuthorization = attestation(key, randomUUID());
    expect(() => verifiedClientNoiseKey(otherAuthorization.raw, binding)).toThrow(/does not verify/);
    const substituted = JSON.parse(good.raw) as Record<string, string>;
    substituted.public_key = randomBytes(32).toString("base64url");
    expect(() => verifiedClientNoiseKey(JSON.stringify(substituted), binding)).toThrow(/does not verify/);
    const weak = attestation(key, binding.authorization_id, Buffer.alloc(32));
    expect(() => verifiedClientNoiseKey(weak.raw, binding)).toThrow(/weak/);
    for (const malformed of ["not json", "{}", JSON.stringify({ ...JSON.parse(good.raw), extra: 1 })]) {
      expect(() => verifiedClientNoiseKey(malformed, binding)).toThrow(ApplicationAuthorizationError);
    }
  });
});

describePostgres("client Noise key storage", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Client key tests require a dedicated local test database.");
    schema = `mdbase_next_client_key_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  it("moves the attested key from request to grant and into the daemon feed", async () => {
    const id = await localGrantFixture(db);
    const key = grantSigningKey();
    const proof = await proofWith(key.publicKey);
    const requestId = proof.binding.authorization_id;
    await db.query(`INSERT INTO authorization_requests (id, user_id, application_id, flow, requested_operations,
      collection_id, operation_transport_protocol, application_agreement_public_key, application_signing_public_key,
      application_authorization, application_installation_id, device_origin, expires_at)
      VALUES ($1, $2, $3, 'device_code', '["read"]'::jsonb, $4, $5, $6, $7, $8::jsonb, $9, 'null', now() + interval '10 minutes')`,
    [requestId, id, id, id, proof.binding.contracts.operation_transport, proof.binding.grant_agreement_public_key,
      proof.binding.grant_signing_public_key, JSON.stringify(proof), proof.binding.application_installation_id]);
    const attested = verifiedClientNoiseKey(attestation(key, requestId).raw, proof.binding)!;
    await storeRequestClientNoiseKey(db, requestId, attested);
    await storeRequestClientNoiseKey(db, requestId, attested);
    await copyClientNoiseKeyToGrant(db, requestId, id);
    await copyClientNoiseKeyToGrant(db, requestId, id);

    await db.query("UPDATE grants SET activated_at = now() WHERE id = $1", [id]);
    const snapshot = await buildPolicySnapshot(db, id, 55_000, undefined, () => true, "lease_v1", false, true) as LeasePolicySnapshot;
    expect(snapshot.grants[0]).toMatchObject({
      client_pk: attested.publicKey.toString("hex"),
      client_key_signature: attested.signature.toString("base64url")
    });

    // Reactivating the grant from a request without a key removes the old one.
    await copyClientNoiseKeyToGrant(db, randomUUID(), id);
    expect((await db.query("SELECT 1 FROM next_grant_client_keys WHERE grant_id = $1", [id])).rows).toHaveLength(0);
  });

  function nextConfig() {
    const pem = (key: import("node:crypto").KeyObject) => key.export({ format: "pem", type: "pkcs8" }).toString();
    const root = generateKeyPairSync("ed25519");
    const policy = generateKeyPairSync("ed25519");
    const rootPublicKey = ed25519RawPublicKey(root.privateKey);
    const now = Date.now();
    const unsigned = { policyPublicKey: ed25519RawPublicKey(policy.privateKey), notBefore: now - 60_000, notAfter: now + 90 * 86_400_000, root: keyId(rootPublicKey) };
    return {
      rootPublicKey, policyPrivateKeyPem: pem(policy.privateKey),
      policyCert: certToJson({ ...unsigned, signature: sign(null, certDigest(unsigned), root.privateKey) }),
      logService: { url: "http://127.0.0.1:9", tokenIssuerKeyPem: pem(generateKeyPairSync("ed25519").privateKey), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) },
      serviceTokens: {}
    };
  }

  it("verifies and stores the key through both request routes, and refuses a bad attestation", async () => {
    const operations = capabilityOperations("collection.read");
    const manifest = registerApplicationManifest({ manifest_version: 1, id: "dev.mdbase.client-key-route", name: "Client key route", distribution: "portable",
      requirements: { contracts: [], access: "full_collection", capabilities: { contract_version: 2, required: ["collection.read"] } } });
    const insertApplication = async (distribution: "portable" | "web") => {
      const applicationId = randomUUID();
      await db.query(`INSERT INTO applications (id, canonical_identity, family_identity, manifest_digest, distribution, name, homepage, redirect_uris,
        requirements, provisions, notifications, application_declaration)
        VALUES ($1, $2, 'bundle:dev.mdbase.client-key-route', $3, $4, 'Client key route', 'https://app.example', $5::jsonb, $6::jsonb,
        '{"type_packs":[],"configuration":[]}'::jsonb, '{"criteria":[]}'::jsonb, $7::jsonb)`,
      [applicationId, `bundle:dev.mdbase.client-key-route:sha256:${manifest.digest}:${applicationId}`, manifest.digest, distribution,
        JSON.stringify(["https://app.example/callback"]), JSON.stringify(manifest.manifest.requirements), JSON.stringify(manifest.manifest)]);
      return applicationId;
    };
    const { app } = await buildApp({ db, publicUrl: "http://connect.test", nextControlPlane: nextConfig() });
    try {
      const verifier = "client-key-route-verifier-000000000000000000000";
      const flows = [
        { distribution: "portable" as const, flow: "device_code" as const, url: "/oauth/device_authorization", extra: {} },
        { distribution: "web" as const, flow: "authorization_code" as const, url: "/oauth/authorization_request",
          extra: { redirect_uri: "https://app.example/callback", state: "client-key-state" } }
      ];
      for (const { distribution, flow, url, extra } of flows) {
        const applicationId = await insertApplication(distribution);
        // Submit a request whose Noise key is attested by `attester` (the binding's own
        // grant signing key when omitted).
        const submit = async (attester?: ReturnType<typeof grantSigningKey>) => {
          const key = grantSigningKey();
          const proof = await testApplicationAuthorization({
            applicationId, applicationDeclarationId: "dev.mdbase.client-key-route", applicationManifestDigest: manifest.digest,
            flow, codeChallenge: pkceChallenge(verifier), requestedOperations: operations, semanticCapabilityContractVersion: 2,
            grantSigningPublicKey: key.publicKey,
            ...(flow === "authorization_code" ? { redirectUri: extra.redirect_uri, state: extra.state } : {})
          });
          const response = await app.inject({
            method: "POST", url,
            headers: { "content-type": "application/x-www-form-urlencoded", ...(flow === "device_code" ? { origin: "null" } : {}) },
            payload: new URLSearchParams({
              client_id: applicationId, operations: operations.join(","),
              code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
              application_authorization: JSON.stringify(proof),
              client_noise_key: attestation(attester ?? key, proof.binding.authorization_id).raw,
              ...extra
            }).toString()
          });
          return { response, authorizationId: proof.binding.authorization_id };
        };
        const rows = async (authorizationId: string) => ({
          request: (await db.query("SELECT 1 FROM authorization_requests WHERE id = $1", [authorizationId])).rows.length,
          key: (await db.query("SELECT 1 FROM next_authorization_client_keys WHERE request_id = $1", [authorizationId])).rows.length
        });

        const good = await submit();
        expect(good.response.statusCode, `${flow}: ${good.response.body}`).toBe(200);
        expect(await rows(good.authorizationId)).toEqual({ request: 1, key: 1 });

        // Attested by another key: the whole request is refused and nothing is stored.
        const forged = await submit(grantSigningKey());
        expect(forged.response.statusCode, flow).toBe(400);
        expect(await rows(forged.authorizationId)).toEqual({ request: 0, key: 0 });
      }
    } finally {
      await app.close();
    }
  });
});
