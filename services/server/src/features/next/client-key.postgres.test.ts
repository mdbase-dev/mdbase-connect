import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApplicationAuthorization } from "../../application-authorization.test-helper.js";
import { ApplicationAuthorizationError } from "../../application-authorization.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { revocationFixture } from "../../local-grant-revocation.test.js";
import { buildPolicySnapshot, type LeasePolicySnapshot } from "../../relay-policy.js";
import { pkceChallenge } from "../../security.js";
import { clientNoiseKeyMessage, copyClientNoiseKeyToGrant, storeRequestClientNoiseKey, verifiedClientNoiseKey } from "./client-key.js";

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
    const id = await revocationFixture(db);
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
    await copyClientNoiseKeyToGrant(db, randomUUID(), id);

    await db.query("UPDATE grants SET activated_at = now() WHERE id = $1", [id]);
    const snapshot = await buildPolicySnapshot(db, id, 55_000, undefined, () => true, "lease_v1", false, true) as LeasePolicySnapshot;
    expect(snapshot.grants[0]).toMatchObject({
      client_pk: attested.publicKey.toString("hex"),
      client_key_signature: attested.signature.toString("base64url")
    });
  });
});
