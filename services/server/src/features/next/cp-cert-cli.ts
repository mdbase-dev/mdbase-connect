// Offline tooling for mdbase-next control-plane keys (policy.md §3).
//
// The root never signs a bare digest: every signing command takes the structured
// content, recomputes the digest itself, and prints what it is about to sign, so an
// operator cannot be handed a certificate digest disguised as a revocation. A
// hardware or air-gapped root uses the same commands' `*-digest` forms, which print
// the same description next to the digest.
//
//   next-cp-cert policy-key
//       Generate a policy key: prints the PKCS#8 PEM (for MDBASE_NEXT_POLICY_SIGNING_KEY),
//       the raw public key and its key ID.
//   next-cp-cert cert-digest <policy_pk> <not_before_ms> <not_after_ms> <root_pk>
//   next-cp-cert sign-cert <root_private_key_pem_file> <policy_pk> <not_before_ms> <not_after_ms>
//       Describe, or sign with a root key file, the certificate of a policy key.
//   next-cp-cert cert <policy_pk> <not_before_ms> <not_after_ms> <root_pk> <root_signature>
//       Verify the root signature and print the certificate JSON (MDBASE_NEXT_POLICY_KEY_CERT).
//   next-cp-cert revocation-digest <policy_key_id> <revoked_from_ms>
//   next-cp-cert sign-revocation <root_private_key_pem_file> <policy_key_id> <revoked_from_ms>
//       Describe, or sign with a root key file, a cp-key-revoke.
//
// Root key files are for LAB and tests; production roots stay offline. All keys,
// digests and signatures are lowercase hex.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { certDigest, keyId, keyRevocationDigest } from "./policy-wire.js";
import { certToJson, ed25519RawPublicKey, verifyCert } from "./policy-keys.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function bytes(value: string | undefined, size: number, name: string): Uint8Array {
  if (!value || !new RegExp(`^[0-9a-f]{${size * 2}}$`).test(value)) throw new Error(`${name}: expected ${size} bytes of lowercase hex`);
  return Buffer.from(value, "hex");
}

function integer(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name}: expected a non-negative integer (milliseconds)`);
  return parsed;
}

const time = (ms: number) => `${ms} (${new Date(ms).toISOString()})`;

function unsignedCert(policyPk: string | undefined, notBefore: string | undefined, notAfter: string | undefined, rootPublicKey: Uint8Array) {
  const cert = {
    policyPublicKey: bytes(policyPk, 32, "policy_pk"),
    notBefore: integer(notBefore, "not_before"),
    notAfter: integer(notAfter, "not_after"),
    root: keyId(rootPublicKey),
  };
  if (cert.notBefore >= cert.notAfter) throw new Error("not_before must precede not_after");
  const description = [
    "CERTIFY a control-plane policy key",
    `  policy key     ${hex(cert.policyPublicKey)} (key ID ${hex(keyId(cert.policyPublicKey))})`,
    `  valid from     ${time(cert.notBefore)}`,
    `  valid until    ${time(cert.notAfter)}`,
    `  root key ID    ${hex(cert.root)}`,
  ].join("\n");
  return { cert, description, digest: certDigest(cert) };
}

function revocation(policyKeyId: string | undefined, revokedFrom: string | undefined) {
  const id = bytes(policyKeyId, 16, "policy_key_id");
  const from = integer(revokedFrom, "revoked_from");
  const description = [
    "REVOKE a control-plane policy key",
    `  policy key ID  ${hex(id)}`,
    `  items issued at or after ${time(from)} become invalid`,
  ].join("\n");
  return { description, digest: keyRevocationDigest(id, from) };
}

function rootKey(file: string | undefined) {
  if (!file) throw new Error("a root private key PEM file is required");
  const key = createPrivateKey(readFileSync(file, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the root key must be Ed25519");
  return { key, publicKey: ed25519RawPublicKey(key) };
}

export function runCpCertCommand(args: string[]): string {
  const [command, ...rest] = args;
  switch (command) {
    case "policy-key": {
      const { privateKey } = generateKeyPairSync("ed25519");
      const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      const publicKey = ed25519RawPublicKey(privateKey);
      return `${pem}public_key ${hex(publicKey)}\nkey_id ${hex(keyId(publicKey))}`;
    }
    case "cert-digest": {
      const { description, digest } = unsignedCert(rest[0], rest[1], rest[2], bytes(rest[3], 32, "root_pk"));
      return `${description}\ndigest ${hex(digest)}`;
    }
    case "sign-cert": {
      const root = rootKey(rest[0]);
      const { description, digest } = unsignedCert(rest[1], rest[2], rest[3], root.publicKey);
      return `${description}\nsignature ${hex(sign(null, digest, root.key))}`;
    }
    case "cert": {
      const rootPk = bytes(rest[3], 32, "root_pk");
      const { cert: unsigned } = unsignedCert(rest[0], rest[1], rest[2], rootPk);
      const cert = { ...unsigned, signature: bytes(rest[4], 64, "root_signature") };
      if (!verifyCert(cert, rootPk)) throw new Error("the root signature does not verify");
      return JSON.stringify(certToJson(cert));
    }
    case "revocation-digest": {
      const { description, digest } = revocation(rest[0], rest[1]);
      return `${description}\ndigest ${hex(digest)}`;
    }
    case "sign-revocation": {
      const root = rootKey(rest[0]);
      const { description, digest } = revocation(rest[1], rest[2]);
      return `${description}\nsignature ${hex(sign(null, digest, root.key))}`;
    }
    default:
      throw new Error("usage: next-cp-cert policy-key | cert-digest | sign-cert | cert | revocation-digest | sign-revocation (see the file header)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${runCpCertCommand(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
