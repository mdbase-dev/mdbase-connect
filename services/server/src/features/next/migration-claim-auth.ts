// Hosted-role authentication housekeeping, not a migration/serving permission.
// Call only with authoritative current SQL facts inside the canonical collection
// transaction. Public DTO equality never supplies this currentness by itself.
import { randomBytes, verify as edVerify } from "node:crypto";
import { localBuild, localDeployment } from "../../local-deployment.js";
import type { DatabaseConnection } from "../../database-types.js";
import { CreateError } from "./bootstrap-common.js";
import { weakAgreementKey, weakSigningKey } from "./devices.js";
import { ed25519PublicKeyObject } from "./policy-keys.js";
import { domainHash, encodeCbor, uuidBytes } from "./policy-wire.js";

export interface ServiceClaimFacts {
  collection_id: string;
  owner_account: string;
  started_us: string;
  target: null | { runtime: string; root_key_id: string; hosted: {
    device_id: string; sign_pk: string; kem_pk: string; noise_pk: string;
  } };
}
const PURPOSE = "migration-claim-read/v1";
const DOMAIN = "mdbase/v1/cp-hosted-migration-claim-read";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/u;
const NIL = "00000000-0000-0000-0000-000000000000";

/** Owned configuration only: never a request Host header, selector or nonce reply.
 * Matches the native first-slice DNS/IPv4 canonical origin profile; IPv6 refuses. */
export function configuredClaimAudience(value: string): string {
  const url = new URL(value);
  if (value.length > 255 || !/^[\x21-\x7e]+$/u.test(value) || (localBuild() ? !localDeployment("local", value) : url.protocol !== "https:")
      || url.origin !== value || !/^[a-z0-9.-]+$/u.test(url.hostname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error("The hosted claim read requires a configured canonical HTTPS origin.");
  }
  return value;
}

function bytes(value: string, length: number): Buffer {
  if (!new RegExp(`^[0-9a-f]{${length * 2}}(?![\\s\\S])`, "u").test(value)) throw new CreateError(503, "not_ready");
  return Buffer.from(value, "hex");
}
function hosted(facts: ServiceClaimFacts) {
  const target = facts.target;
  if (!target || target.runtime !== "shadow" || !UUID.test(facts.collection_id) || facts.collection_id === NIL
      || !UUID.test(facts.owner_account) || facts.owner_account === NIL
      || !UUID.test(target.hosted.device_id) || target.hosted.device_id === NIL
      || !/^[1-9][0-9]{0,23}(?![\s\S])/u.test(facts.started_us)) throw new CreateError(409, "migration_subject_not_current");
  const sign = bytes(target.hosted.sign_pk, 32), kem = bytes(target.hosted.kem_pk, 32), noise = bytes(target.hosted.noise_pk, 32);
  if (weakSigningKey(sign) || weakAgreementKey(kem) || weakAgreementKey(noise)) throw new CreateError(503, "not_ready");
  return { device: target.hosted.device_id, root: bytes(target.root_key_id, 16), sign, kem, noise };
}

/** Closed canonical wire template, also pinned by the native shared golden fixture.
 * A digest/signature is authentication DATA, not FULL/physical/pending authority. */
export function serviceClaimReadDigest(audience: string, facts: ServiceClaimFacts, challenge: Uint8Array): Uint8Array {
  const identity = hosted(facts);
  if (challenge.length !== 32) throw new CreateError(400, "invalid_request");
  return domainHash(DOMAIN, encodeCbor([1, configuredClaimAudience(audience), "POST",
    `/internal/v1/next/migration/collections/${facts.collection_id}/claim/read`,
    uuidBytes(facts.collection_id), uuidBytes(identity.device), identity.root,
    identity.sign, identity.kem, identity.noise, challenge]));
}

// Exact existing SQL identity/source facts, not a new CP version or authority lease.
function subjectHash(facts: ServiceClaimFacts): Buffer {
  const identity = hosted(facts);
  return Buffer.from(domainHash("mdbase/v1/cp-hosted-migration-claim-subject", encodeCbor([
    uuidBytes(facts.collection_id), uuidBytes(facts.owner_account), facts.started_us,
    uuidBytes(identity.device), identity.root, identity.sign, identity.kem, identity.noise
  ])));
}
export function sameServiceClaim(a: ServiceClaimFacts, b: ServiceClaimFacts): boolean {
  return subjectHash(a).equals(subjectHash(b));
}

/** Requires the caller's owner-before-collection locks and current hosted row lock.
 * One live nonce; no overwrite, renewal, fallback or migration/policy mutation. */
export async function issueServiceClaimChallenge(client: DatabaseConnection, audience: string, facts: ServiceClaimFacts, device: string) {
  const identity = hosted(facts);
  if (identity.device !== device) throw new CreateError(409, "migration_subject_not_current");
  const scope = [facts.collection_id, device, PURPOSE, audience];
  // Keep consumed recent rows for the bounded per-subject rate check. Expired
  // unused rows cannot authorize anything and must release the unique slot.
  await client.query(`DELETE FROM next_device_challenges WHERE connector_id IS NULL
    AND service_collection_id=$1 AND service_device_id=$2 AND service_purpose=$3 AND service_audience=$4
    AND expires_at <= clock_timestamp() AND (used_at IS NULL OR expires_at < clock_timestamp()-interval '1 minute')`, scope);
  const rows = await client.query<{ n: number; live: boolean }>(`SELECT count(*)::int AS n,
    coalesce(bool_or(used_at IS NULL AND expires_at > clock_timestamp()),false) AS live
    FROM next_device_challenges WHERE connector_id IS NULL AND service_collection_id=$1 AND service_device_id=$2
      AND service_purpose=$3 AND service_audience=$4 AND expires_at > clock_timestamp()-interval '1 minute'`, scope);
  if (rows.rows[0]?.live) throw new CreateError(409, "challenge_pending");
  if ((rows.rows[0]?.n ?? 20) >= 20) throw new CreateError(429, "challenge_rate_limited");
  const challenge = randomBytes(32);
  await client.query(`INSERT INTO next_device_challenges
    (challenge,service_collection_id,service_device_id,service_purpose,service_audience,service_subject_hash,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 seconds')`,
  [challenge, ...scope, subjectHash(facts)]);
  return { challenge: challenge.toString("hex") };
}

/** Verify against CP's locked CURRENT key, then consume in the SAME transaction
 * as the final canonical read. Expiry uses actual DB time even after lock waits. */
export async function consumeServiceClaimChallenge(client: DatabaseConnection, audience: string, facts: ServiceClaimFacts,
  proof: { device_id: string; challenge: string; sig: string }): Promise<void> {
  const identity = hosted(facts), challenge = bytes(proof.challenge, 32), sig = bytes(proof.sig, 64);
  if (identity.device !== proof.device_id
      || !edVerify(null, serviceClaimReadDigest(audience, facts, challenge), ed25519PublicKeyObject(identity.sign), sig)) {
    throw new CreateError(401, "invalid_service_proof");
  }
  const used = await client.query(`UPDATE next_device_challenges SET used_at=clock_timestamp()
    WHERE challenge=$1 AND connector_id IS NULL AND service_collection_id=$2 AND service_device_id=$3
      AND service_purpose=$4 AND service_audience=$5 AND service_subject_hash=$6
      AND used_at IS NULL AND expires_at > clock_timestamp()`,
  [challenge, facts.collection_id, identity.device, PURPOSE, audience, subjectHash(facts)]);
  if (used.rowCount !== 1) throw new CreateError(409, "challenge_invalid");
}
