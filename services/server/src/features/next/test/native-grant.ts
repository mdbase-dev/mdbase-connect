import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authorizationOperations, capabilityOperations } from "@mdbase-dev/connect-protocol";
import type { DatabasePool } from "../../../database-types.js";
import { createTestApplicationIdentity, testApplicationAuthorization } from "../../../application-authorization.test-helper.js";
import { registerApplicationManifest } from "../../../manifest.js";
import { pkceChallenge, tokenHash } from "../../../security.js";
import { clientNoiseKeyMessage, storeRequestClientNoiseKey, verifiedClientNoiseKey } from "../client-key.js";
const OPERATIONS: string[] = [...capabilityOperations("collection.read")];

/** A registered web app that asks for read access, and its consent requests. */
let apps = 0;
export async function nativeReadApp(db: DatabasePool, portal: FastifyInstance, legacy = false, setup?: Record<string, unknown>) {
  const declaration = `dev.mdbase.private-web${++apps}`;
  const files = { actions: ["list", "read"] as Array<"list" | "read">, scope: { kind: "collection" as const } };
  const manifest = registerApplicationManifest(setup ? { ...setup, id: declaration, distribution: "web", homepage: "https://app.example", icon: "https://app.example/icon.png", redirect_uris: ["https://app.example/callback"] } : { manifest_version: 1, id: declaration, name: "Private web", distribution: "web", homepage: "https://app.example", redirect_uris: ["https://app.example/callback"],
    requirements: legacy
      ? { contracts: [], access: "full_collection", files,
          capabilities: { contract_version: 1, required: ["collection.inspect", "records.watch", "records.read", "records.query", "views.list", "views.execute", "views.source.read", "records.validate", "definitions.read", "files.list", "files.read"], optional: ["records.update", "records.rename"] } }
      : { contracts: [], access: "full_collection", files: { required: ["list", "read"], scope: files.scope },
          capabilities: { contract_version: 2, required: ["collection.read"] } } });
  const application = randomUUID();
  await db.query(`INSERT INTO applications (id, canonical_identity, family_identity, manifest_digest, distribution, name, homepage, redirect_uris,
    requirements, provisions, notifications, application_declaration)
    VALUES ($1, $2, $6, $3, 'web', 'Private web', 'https://app.example', '["https://app.example/callback"]'::jsonb,
    $4::jsonb, $7::jsonb, '{"criteria":[]}'::jsonb, $5::jsonb)`,
  [application, `bundle:${declaration}:sha256:${manifest.digest}`, manifest.digest, JSON.stringify(manifest.manifest.requirements), JSON.stringify(manifest.manifest), `bundle:${declaration}`, JSON.stringify(manifest.manifest.provisions ?? { type_packs: [], configuration: [] })]);
  // One browser profile of the app: every request comes from the same installation.
  const installationIdentity = createTestApplicationIdentity();
  return async (account: string, collection: string) => {
    const requested = legacy ? [...OPERATIONS, "update", "rename"] : setup ? authorizationOperations(manifest.manifest, {}) : OPERATIONS;
    const fileActions = setup ? ["list", "read", "add", "replace", "move"] as const : files.actions;
    const signing = createTestApplicationIdentity();
    const proof = await testApplicationAuthorization({ installationIdentity, grantSigningPublicKey: signing.publicKey, applicationId: application, applicationDeclarationId: declaration,
      applicationManifestDigest: manifest.digest, flow: "authorization_code", redirectUri: "https://app.example/callback", state: "s",
      codeChallenge: pkceChallenge("private-web-verifier-0000000000000000000000000"), requestedOperations: requested as never,
      semanticCapabilityContractVersion: legacy ? 1 : 2, requestedFiles: { ...files, actions: [...fileActions] } });
    const id = proof.binding.authorization_id;
    await db.query(`INSERT INTO authorization_requests (id, user_id, application_id, flow, redirect_uri, state, code_challenge, requested_operations,
      operation_transport_protocol, application_agreement_public_key, application_signing_public_key, application_authorization,
      application_installation_id, expires_at)
      VALUES ($1, $2, $3, 'authorization_code', 'https://app.example/callback', 's', $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10, now() + interval '10 minutes')`,
    [id, account, application, proof.binding.code_challenge, JSON.stringify(requested), proof.binding.contracts.operation_transport,
      proof.binding.grant_agreement_public_key, proof.binding.grant_signing_public_key, JSON.stringify(proof), proof.binding.application_installation_id]);
    const noise = (generateKeyPairSync("x25519").publicKey.export({format:"der",type:"spki"}) as Buffer).subarray(-32);
    const signature = sign("sha256",clientNoiseKeyMessage(id,noise),{key:signing.privateKey,dsaEncoding:"ieee-p1363"});
    await storeRequestClientNoiseKey(db,id,verifiedClientNoiseKey(JSON.stringify({public_key:noise.toString("base64url"),signature:signature.toString("base64url")}),proof.binding)!);
    const session = randomUUID();
    await db.query(`INSERT INTO sessions (id, user_id, token_hash, provider, account_session_epoch, expires_at)
      VALUES ($1, $2, $3, 'password', COALESCE((SELECT session_epoch FROM users WHERE id = $2), 1), now() + interval '1 day')`, [randomUUID(), account, tokenHash(session)]);
    const headers = { cookie: `mdbase_session=${session}` };
    return {
      id,
      status: () => portal.inject({method:"GET",url:`/v1/authorization-requests/${id}/status`,headers}),
      exchange: (code:string) => portal.inject({method:"POST",url:"/oauth/token",payload:{grant_type:"authorization_code",code,client_id:application,redirect_uri:"https://app.example/callback",code_verifier:"private-web-verifier-0000000000000000000000000"}}),
      view: () => portal.inject({ method: "GET", url: `/v1/authorization-requests/${id}`, headers }),
      approve: (operations = requested) => portal.inject({ method: "POST", url: `/v1/authorization-requests/${id}/approve`, headers,
        payload: { collection_id: collection, operations, file_actions: [...fileActions] } })
    };
  };
}
