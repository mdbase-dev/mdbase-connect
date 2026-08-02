import {
  applicationInstallationIdFromPublicKeys,
  authorizationSigningMessage,
  type ApplicationAuthorizationBinding,
  type ApplicationAuthorizationProof
} from "@mdbase-dev/connect-protocol";
import type { GrantKeyRecord } from "./crypto.js";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF_ORDER = P256_ORDER / 2n;

export { authorizationSigningMessage };

export async function applicationInstallationId(
  identity: Pick<GrantKeyRecord, "agreementPublicKey" | "signingPublicKey">
): Promise<string> {
  return applicationInstallationIdFromPublicKeys(
    identity.agreementPublicKey,
    identity.signingPublicKey
  );
}

export async function signApplicationAuthorization(
  binding: ApplicationAuthorizationBinding,
  identity: Pick<GrantKeyRecord, "signingPrivateKey" | "agreementPublicKey" | "signingPublicKey">
): Promise<ApplicationAuthorizationProof> {
  if (
    binding.installation_agreement_public_key !== identity.agreementPublicKey
    || binding.installation_signing_public_key !== identity.signingPublicKey
    || binding.application_installation_id !== await applicationInstallationId(identity)
  ) {
    throw new Error("Application authorization identity does not match its binding.");
  }
  const signature = canonicalSignature(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.signingPrivateKey,
    authorizationSigningMessage(binding) as BufferSource
  )));
  return {
    binding,
    signature: base64Url(signature)
  };
}

function concat(values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce(
    (length, value) => length + value.byteLength,
    0
  ));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function canonicalSignature(signature: Uint8Array): Uint8Array {
  if (signature.byteLength !== 64) {
    throw new Error("Application authorization signature is invalid.");
  }
  const s = bytesBigInt(signature.slice(32));
  if (s === 0n || s >= P256_ORDER) {
    throw new Error("Application authorization signature is invalid.");
  }
  if (s <= P256_HALF_ORDER) return signature;
  return concat([signature.slice(0, 32), bigIntBytes(P256_ORDER - s, 32)]);
}

function bytesBigInt(value: Uint8Array): bigint {
  return BigInt(`0x${hex(value)}`);
}

function bigIntBytes(value: bigint, length: number): Uint8Array {
  const encoded = value.toString(16).padStart(length * 2, "0");
  return Uint8Array.from(
    { length },
    (_, index) => Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16)
  );
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
