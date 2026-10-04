// Offline tooling for mdbase-next control-plane keys (policy.md §3).
//
//   next-cp-cert policy-key
//       Generate a policy key: prints the PKCS#8 PEM (for MDBASE_NEXT_POLICY_SIGNING_KEY)
//       and the raw public key.
//   next-cp-cert cert-digest <policy_pk> <not_before_ms> <not_after_ms> <root_pk>
//       Print the digest the offline root signs.
//   next-cp-cert cert <policy_pk> <not_before_ms> <not_after_ms> <root_pk> <root_signature>
//       Verify the root signature and print the certificate JSON (MDBASE_NEXT_POLICY_KEY_CERT).
//   next-cp-cert revocation-digest <policy_key_id> <revoked_from_ms>
//       Print the digest the root signs for a cp-key-revoke op.
//   next-cp-cert sign <root_private_key_pem_file> <digest>
//       Sign a digest with a root key. For LAB and tests only: production roots stay offline.
//
// All keys, digests and signatures are lowercase hex.
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
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

export function runCpCertCommand(args: string[]): string {
  const [command, ...rest] = args;
  switch (command) {
    case "policy-key": {
      const { privateKey } = generateKeyPairSync("ed25519");
      const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      const publicKey = ed25519RawPublicKey(privateKey);
      return `${pem}public_key ${hex(publicKey)}\nkey_id ${hex(keyId(publicKey))}`;
    }
    case "cert-digest":
    case "cert": {
      const unsigned = {
        policyPublicKey: bytes(rest[0], 32, "policy_pk"),
        notBefore: integer(rest[1], "not_before"),
        notAfter: integer(rest[2], "not_after"),
        root: keyId(bytes(rest[3], 32, "root_pk")),
      };
      if (unsigned.notBefore >= unsigned.notAfter) throw new Error("not_before must precede not_after");
      if (command === "cert-digest") return hex(certDigest(unsigned));
      const cert = { ...unsigned, signature: bytes(rest[4], 64, "root_signature") };
      if (!verifyCert(cert, bytes(rest[3], 32, "root_pk"))) throw new Error("the root signature does not verify");
      return JSON.stringify(certToJson(cert));
    }
    case "revocation-digest":
      return hex(keyRevocationDigest(bytes(rest[0], 16, "policy_key_id"), integer(rest[1], "revoked_from")));
    case "sign": {
      if (!rest[0]) throw new Error("sign needs a PEM file");
      const key = createPrivateKey(readFileSync(rest[0], "utf8"));
      return hex(sign(null, bytes(rest[1], 32, "digest"), key));
    }
    default:
      throw new Error("usage: next-cp-cert policy-key | cert-digest | cert | revocation-digest | sign (see the file header)");
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
