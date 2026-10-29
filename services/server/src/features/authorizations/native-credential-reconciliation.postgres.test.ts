import { ensureDevelopmentEntitlement } from "../../entitlements.js";
// Atomic immutable token metadata only: no reconciliation endpoint or race claim.
import { randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { capabilityOperations } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../db.js";
import { createTestApplicationIdentity, testApplicationAuthorization } from "../../application-authorization.test-helper.js";
import { registerApplicationManifest } from "../../manifest.js";
import { pkceChallenge, tokenHash } from "../../security.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import type { RelayHub } from "../../relay.js";
import { createHostedCollectionMembership } from "../../collection-policy.js";
import { registerAuthorizationPollingRoutes } from "./polling-routes.js";
import { AUTHORITY_PROOF_HEADERS, AUTHORITY_PROOF_VERSION } from "@mdbase-dev/connect-protocol";
import { authorityProofMessage } from "../../authority-proof.js";
import { clientNoiseKeyMessage, copyClientNoiseKeyToGrant, storeRequestClientNoiseKey, verifiedClientNoiseKey } from "../next/client-key.js";
import { registerNextCollection } from "../next/policy-outbox.js";
import { localGrantFixture } from "../next/next-fixtures.test-helper.js";
import { issueApplicationTokens } from "./token-service.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const REDIRECT = "https://native-completion.example.test/callback";

suite("original native token completion (isolated PostgreSQL)", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Native completion requires dedicated local test PostgreSQL.");
    schema = `native_completion_${randomUUID().replaceAll("-", "")}`;
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

  async function fixture(expiredProof = false, memberGrant = false) {
    const account = randomUUID(), app = randomUUID(), request = randomUUID(), collection = randomUUID(), grant = randomUUID();
    const operations = capabilityOperations("collection.read");
    const manifest = registerApplicationManifest({ manifest_version: 1, id: "dev.mdbase.native-completion-test", name: "Native completion", distribution: "web", homepage: new URL(REDIRECT).origin, redirect_uris: [REDIRECT],
      requirements: { contracts: [], access: "full_collection", capabilities: { contract_version: 2, required: ["collection.read"] } } });
    const signing = createTestApplicationIdentity();
    const proof = await testApplicationAuthorization({ applicationId: app, authorizationId: request,
      applicationDeclarationId: manifest.manifest.id, applicationManifestDigest: manifest.digest,
      flow: "authorization_code", redirectUri: REDIRECT, state: randomUUID(), codeChallenge: pkceChallenge("native-completion-verifier-0000000000000000000"),
      requestedOperations: operations, semanticCapabilityContractVersion: 2, collectionId: collection, grantSigningPublicKey: signing.publicKey,
      ...(expiredProof ? { issuedAt: new Date(Date.now() - 86_400_000) } : {}) });
    const noise = randomBytes(32);
    const signature = sign("sha256", clientNoiseKeyMessage(request, noise), { key: signing.privateKey, dsaEncoding: "ieee-p1363" });
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'[test] Native completion','next')", [account, `${account}@example.test`]);
    await db.query(`INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris,distribution,manifest_digest,requirements,application_declaration)
      VALUES($1,$2,'Native completion',$3,$4::jsonb,'web',$5,$6::jsonb,$7::jsonb)`,
    [app, `native-completion:${app}`, new URL(REDIRECT).origin, JSON.stringify([REDIRECT]), manifest.digest, JSON.stringify(manifest.manifest.requirements), JSON.stringify(manifest.manifest)]);
    const root = randomBytes(16);
    const owner = memberGrant ? randomUUID() : account;
    if (memberGrant) await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'[test] Collection owner','next')", [owner, `${owner}@example.test`]);
    await ensureDevelopmentEntitlement(db, owner);
    await registerNextCollection(db, { collectionId: collection, ownerUserId: owner, runtime: "next", sync: "private", rootKeyId: root, displayName: "[test] Private completion",
      ops: [{ op: "genesis", owner, root, state: "e2e" }, { op: "member-set", account: owner, role: "owner" }] });
    if (memberGrant) await createHostedCollectionMembership(db, { collectionId: collection, ownerUserId: owner, userId: account, role: "editor" });
    const batch = await db.query<{id: string}>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,1,$2,$3,1,'appended',now()) RETURNING id", [collection, Buffer.alloc(32), Buffer.from([1])]);
    await db.query("UPDATE next_policy_outbox SET batch_id=$1 WHERE collection_id=$2 AND batch_id IS NULL", [batch.rows[0]!.id, collection]);
    await db.query(`INSERT INTO authorization_requests(id,user_id,application_id,flow,requested_operations,collection_id,operation_transport_protocol,
      application_agreement_public_key,application_signing_public_key,application_authorization,application_installation_id,redirect_uri,code_challenge,state,expires_at)
      VALUES($1,$2,$3,'authorization_code',$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,now()+interval '10 minutes')`,
    [request, account, app, JSON.stringify(operations), collection, proof.binding.contracts.operation_transport, proof.binding.grant_agreement_public_key,
      signing.publicKey, JSON.stringify(proof), proof.binding.application_installation_id, REDIRECT, proof.binding.code_challenge, proof.binding.state]);
    await storeRequestClientNoiseKey(db, request, verifiedClientNoiseKey(JSON.stringify({ public_key: noise.toString("base64url"), signature: signature.toString("base64url") }), proof.binding)!);
    await db.query(`INSERT INTO grants(id,user_id,application_id,next_collection_id,operations,scope,proof_public_key,application_origin,application_authorization,application_installation_id,activated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'{"access":"full_collection","contracts":[]}',$6,$7,$8::jsonb,$9,now())`,
    [grant, account, app, collection, JSON.stringify(operations), signing.publicKey, new URL(REDIRECT).origin, JSON.stringify(proof), proof.binding.application_installation_id]);
    await copyClientNoiseKeyToGrant(db, request, grant);
    await db.query("UPDATE authorization_requests SET completed_at=now(),grant_id=$2 WHERE id=$1", [request, grant]);
    return { account, owner, app, request, collection, grant, proof, signing, noise, signature };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function counts(f: Fixture) {
    const r = await db.query<{access: string; refresh: string}>(`SELECT
      (SELECT count(*) FROM access_tokens WHERE grant_id=$1) AS access,
      (SELECT count(*) FROM refresh_tokens WHERE grant_id=$1) AS refresh`, [f.grant]);
    return r.rows[0];
  }
  async function issue(f: Fixture) {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      const result = await issueApplicationTokens(c, undefined, f.grant);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally { c.release(); }
  }
  function expected(f: Fixture) {
    return { version: 1, account_id: f.account, authorization_request_id: f.request, application_id: f.app,
      application_declaration_id: f.proof.binding.application_declaration_id, application_manifest_digest: f.proof.binding.application_manifest_digest,
      application_installation_id: f.proof.binding.application_installation_id, application_origin: new URL(REDIRECT).origin,
      collection_id: f.collection, grant_id: f.grant, grant_signing_public_key: f.signing.publicKey, client_noise_public_key: f.noise.toString("base64url") };
  }

  it("returns the independently stored original tuple with no computer online or native admission promise", async () => {
    const f = await fixture();
    // No device/presence/grant approval exists; metadata is not readiness.
    const reply = await issue(f);
    expect(reply).toMatchObject({ grant_id: f.grant, collection_id: f.collection, native_completion: expected(f) });
    expect(Object.keys(reply)).not.toContain("ready");
    expect(await counts(f)).toEqual({ access: "1", refresh: "1" });
  });
  it("keeps completed request expiry distinct from active grant lifetime and immutable manifest facts", async () => {
    const f = await fixture(true);
    await db.query("UPDATE authorization_requests SET expires_at=now()-interval '1 day' WHERE id=$1", [f.request]);
    await db.query("UPDATE applications SET manifest_digest=$2 WHERE id=$1", [f.app, "b".repeat(64)]);
    expect(await issue(f)).toMatchObject({ native_completion: expected(f) });
  });

  it("authenticates approving member B rather than collection owner A", async () => {
    const f = await fixture(false, true);
    expect(f.account).not.toBe(f.owner);
    expect(await issue(f)).toMatchObject({ native_completion: expected(f) });
  });

  it.each(["authorization_code", "refresh_token"] as const)("rolls back %s consumption on immutable tuple rejection", async kind => {
    const f = await fixture();
    await db.query("UPDATE next_grant_client_keys SET signature=NULL WHERE grant_id=$1", [f.grant]);
    const app = Fastify();
    registerErrorHandler(app);
    registerAuthorizationPollingRoutes(app, { db, relay: {} as RelayHub, publicUrl: "https://connect.example.test", drainProviderRevocations: async () => {} });
    const credential = randomUUID(), rowId = randomUUID();
    const body: Record<string, string> = kind === "authorization_code"
      ? { grant_type: kind, code: credential, client_id: f.app, redirect_uri: REDIRECT, code_verifier: "native-completion-verifier-0000000000000000000" }
      : { grant_type: kind, refresh_token: credential, client_id: f.app };
    const headers: Record<string, string> = {};
    if (kind === "authorization_code") {
      await db.query("INSERT INTO authorization_codes(id,code_hash,grant_id,application_id,redirect_uri,code_challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '2 minutes')", [rowId, tokenHash(credential), f.grant, f.app, REDIRECT, f.proof.binding.code_challenge]);
    } else {
      await db.query("INSERT INTO refresh_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [rowId, tokenHash(credential), f.grant]);
      const timestamp = Math.floor(Date.now()/1_000), nonce = randomUUID();
      const message = authorityProofMessage({ method: "POST", target: "/oauth/token", body: new URLSearchParams(body).toString(), credential, timestamp, nonce });
      headers[AUTHORITY_PROOF_HEADERS.version] = String(AUTHORITY_PROOF_VERSION);
      headers[AUTHORITY_PROOF_HEADERS.timestamp] = String(timestamp);
      headers[AUTHORITY_PROOF_HEADERS.nonce] = nonce;
      headers[AUTHORITY_PROOF_HEADERS.signature] = sign("sha256", Buffer.from(message), { key: f.signing.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    }
    try {
      const response = await app.inject({ method: "POST", url: "/oauth/token", payload: body, headers });
      expect(response.statusCode).toBe(400);
      const table = kind === "authorization_code" ? "authorization_codes" : "refresh_tokens";
      expect((await db.query(`SELECT used_at FROM ${table} WHERE id=$1`, [rowId])).rows).toEqual([{ used_at: null }]);
      expect(await counts(f)).toEqual({ access: "0", refresh: kind === "refresh_token" ? "1" : "0" });
    } finally { await app.close(); }
  });

  it("leaves local legacy token replies without native metadata", async () => {
    const grant = await localGrantFixture(db);
    await db.query("UPDATE grants SET activated_at=now() WHERE id=$1", [grant]);
    const reply = await issueApplicationTokens(db, undefined, grant);
    expect(Object.hasOwn(reply, "native_completion")).toBe(false);
    expect(reply.grant_id).toBe(grant);
  });

  it("leaves hosted token replies and provider credential rotation unchanged", async () => {
    const grant = await localGrantFixture(db), collection = randomUUID(), replica = randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url) VALUES($1,$2,'[test] Hosted','mdbase','https://provider.example.test')", [collection, grant]);
    await db.query("INSERT INTO hosted_replicas(id,collection_id,authorized_user_id,name,purpose,mode) VALUES($1,$2,$3,'[test] App','application','read_write')", [replica, collection, grant]);
    await db.query("UPDATE grants SET collection_id=NULL,hosted_collection_id=$2,hosted_replica_id=$3,activated_at=now() WHERE id=$1", [grant, collection, replica]);
    const rotateReplicaToken = vi.fn();
    const reply = await issueApplicationTokens(db, { rotateReplicaToken } as unknown as HostedProviderClient, grant);
    expect(Object.hasOwn(reply, "native_completion")).toBe(false);
    expect(reply.collection_id).toBe(collection);
    expect(reply.grant_id).toBe(grant);
    expect(reply.authority?.replica_id).toBe(replica);
    expect(rotateReplicaToken).toHaveBeenCalledOnce();
  });

  const faults = ["request-incomplete", "request-authorization", "grant-installation", "request-declaration", "request-redirect", "request-target", "wrong-attestation-domain", "request-account", "request-grant", "request-app", "request-installation", "request-signing", "grant-signing", "request-proof", "grant-origin",
    "request-noise", "grant-noise", "missing-request-attestation", "missing-grant-attestation", "invalid-attestation", "grant-target", "unbound", "revoked", "suspended", "deleted", "removed-member"] as const;
  it.each(faults)("refuses %s before credential writes", async fault => {
    const f = await fixture();
    if (fault === "request-incomplete") await db.query("UPDATE authorization_requests SET completed_at=NULL WHERE id=$1", [f.request]);
    if (fault === "request-authorization") {
      const proof = structuredClone(f.proof);
      proof.binding.authorization_id = randomUUID();
      await db.query("UPDATE grants SET application_authorization=$2::jsonb WHERE id=$1", [f.grant, JSON.stringify(proof)]);
    }
    if (fault === "grant-installation") await db.query("UPDATE grants SET application_installation_id=$2 WHERE id=$1", [f.grant, randomUUID()]);
    if (fault === "request-declaration") {
      const proof = structuredClone(f.proof);
      proof.binding.application_declaration_id = "dev.mdbase.other";
      await db.query("UPDATE authorization_requests SET application_authorization=$2::jsonb WHERE id=$1", [f.request, JSON.stringify(proof)]);
    }
    if (fault === "request-redirect") await db.query("UPDATE authorization_requests SET redirect_uri='https://other.example.test/callback' WHERE id=$1", [f.request]);
    if (fault === "request-target") await db.query("UPDATE authorization_requests SET collection_id=$2 WHERE id=$1", [f.request, randomUUID()]);
    if (fault === "wrong-attestation-domain") {
      const signature = sign("sha256", clientNoiseKeyMessage(randomUUID(), f.noise), { key: f.signing.privateKey, dsaEncoding: "ieee-p1363" });
      await db.query("UPDATE next_authorization_client_keys SET signature=$2 WHERE request_id=$1", [f.request, signature]);
      await db.query("UPDATE next_grant_client_keys SET signature=$2 WHERE grant_id=$1", [f.grant, signature]);
    }
    if (fault === "request-account") {
      const other = randomUUID();
      await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'[test] Other')", [other, `${other}@example.test`]);
      await db.query("UPDATE authorization_requests SET user_id=$2 WHERE id=$1", [f.request, other]);
    }
    if (fault === "request-grant") await db.query("UPDATE authorization_requests SET grant_id=NULL WHERE id=$1", [f.request]);
    if (fault === "request-app") {
      const other = randomUUID();
      await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1,$2,'Other','https://other.example.test','[]')", [other, other]);
      await db.query("UPDATE authorization_requests SET application_id=$2 WHERE id=$1", [f.request, other]);
    }
    if (fault === "request-installation") await db.query("UPDATE authorization_requests SET application_installation_id=$2 WHERE id=$1", [f.request, randomUUID()]);
    if (fault === "request-signing" || fault === "grant-signing") {
      const key = createTestApplicationIdentity();
      const table = fault === "request-signing" ? "authorization_requests" : "grants";
      const column = fault === "request-signing" ? "application_signing_public_key" : "proof_public_key";
      await db.query(`UPDATE ${table} SET ${column}=$2 WHERE id=$1`, [fault === "request-signing" ? f.request : f.grant, key.publicKey]);
    }
    if (fault === "request-proof") {
      const proof = structuredClone(f.proof);
      proof.binding.application_manifest_digest = "c".repeat(64);
      await db.query("UPDATE authorization_requests SET application_authorization=$2::jsonb WHERE id=$1", [f.request, JSON.stringify(proof)]);
    }
    if (fault === "grant-origin") await db.query("UPDATE grants SET application_origin='https://other.example.test' WHERE id=$1", [f.grant]);
    if (fault === "request-noise" || fault === "grant-noise") {
      const table = fault === "request-noise" ? "next_authorization_client_keys" : "next_grant_client_keys";
      const column = fault === "request-noise" ? "request_id" : "grant_id";
      await db.query(`UPDATE ${table} SET client_pk=$2 WHERE ${column}=$1`, [fault === "request-noise" ? f.request : f.grant, randomBytes(32)]);
    }
    if (fault === "missing-request-attestation") await db.query("DELETE FROM next_authorization_client_keys WHERE request_id=$1", [f.request]);
    if (fault === "missing-grant-attestation") await db.query("UPDATE next_grant_client_keys SET signature=NULL WHERE grant_id=$1", [f.grant]);
    if (fault === "invalid-attestation") {
      const bad = randomBytes(64);
      await db.query("UPDATE next_authorization_client_keys SET signature=$2 WHERE request_id=$1", [f.request, bad]);
      await db.query("UPDATE next_grant_client_keys SET signature=$2 WHERE grant_id=$1", [f.grant, bad]);
    }
    if (fault === "grant-target") {
      const proof = structuredClone(f.proof);
      proof.binding.collection_id = randomUUID();
      await db.query("UPDATE grants SET application_authorization=$2::jsonb WHERE id=$1", [f.grant, JSON.stringify(proof)]);
      await db.query("UPDATE authorization_requests SET application_authorization=$2::jsonb WHERE id=$1", [f.request, JSON.stringify(proof)]);
    }
    if (fault === "unbound") await db.query("UPDATE grants SET application_authorization=$2::jsonb WHERE id=$1", [f.grant, JSON.stringify({ binding: { protocol_version: 5 }, signature: "unbound" })]);
    if (fault === "revoked") await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [f.grant]);
    if (fault === "suspended") await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.account]);
    if (fault === "deleted") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [f.collection, randomUUID()]);
    if (fault === "removed-member") await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2::jsonb)", [f.collection, JSON.stringify({ version: 1, ops: [{ op: "member-remove", account: f.account }] })]);
    const accepted = await issue(f).then(() => true, () => false);
    // Do not dump a baseline's accidentally issued credential pair on failure.
    expect(accepted).toBe(false);
    expect(await counts(f)).toEqual({ access: "0", refresh: "0" });
  });
});
