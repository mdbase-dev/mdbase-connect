// Migration-source authority is a distinct use of the existing CP policy signer,
// not an app session, log token, raw-sealer capability, or a new signing key.
import { sign } from "node:crypto";
import { domainHash, encodeCbor, encodeCert, uuidBytes, type PolicySigner } from "./policy-wire.js";

const DOMAIN = "mdbase-next/migration-source/v1";
const TTL_MS = 15 * 60 * 1000;
const MAX_U64 = (1n << 64n) - 1n;
const NIL = "00000000-0000-0000-0000-000000000000";

interface SourceFacts {
  target: string;
  device: string;
  epoch: bigint;
  legacy: string;
  frozenHead: bigint;
  startedAt: number;
  wake: bigint;
  issuedAt: number;
}

function canonicalUuid(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value) || value === NIL) {
    throw new Error("migration source needs a canonical non-nil UUID");
  }
  return uuidBytes(value);
}

function u64(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) throw new Error("migration source counter outside u64");
  return value;
}

/** Pure wire encoder only: facts must already be derived from authenticated
 * provider/native state and the freshly rechecked immutable CP start claim.
 * Calling this encoder is not itself admission or permission to serve. */
export function signMigrationSourceWitness(signer: PolicySigner, facts: SourceFacts): { witness: Uint8Array; expiresAt: number } {
  if (!Number.isSafeInteger(facts.startedAt) || !Number.isSafeInteger(facts.issuedAt) || facts.startedAt > facts.issuedAt) {
    throw new Error("migration source timestamps must be integer milliseconds, start no later than issuance");
  }
  const expiresAt = Math.min(facts.issuedAt + TTL_MS, signer.cert.notAfter);
  if (!Number.isSafeInteger(expiresAt) || facts.issuedAt < signer.cert.notBefore || expiresAt <= facts.issuedAt) {
    throw new Error("migration source issuance outside certificate window");
  }
  const claims = encodeCbor([
    1, canonicalUuid(facts.target), canonicalUuid(facts.device), u64(facts.epoch),
    canonicalUuid(facts.legacy), u64(facts.frozenHead), facts.startedAt,
    u64(facts.wake), facts.issuedAt, expiresAt,
  ]);
  const signature = sign(null, domainHash(DOMAIN, claims), signer.privateKey);
  // Fixed canonical four-element array/version prefix. Reuse the existing
  // certificate encoder verbatim rather than introducing a second CpCert map.
  const witness = Buffer.concat([Buffer.of(0x84, 1), encodeCbor(claims), encodeCert(signer.cert), encodeCbor(signature)]);
  if (witness.length > 4096) throw new Error("migration source envelope exceeds wire bound");
  return { witness, expiresAt };
}
