import type {
  ApplicationAuthorizationBinding,
  ApplicationAuthorizationProof
} from "@mdbase-dev/connect-protocol";
import type { GrantKeyRecord } from "./crypto.js";

const INSTALLATION_ID_DOMAIN = new TextEncoder().encode(
  "mdbase-connect application installation id v1\0"
);
const AUTHORIZATION_PROOF_DOMAIN = new TextEncoder().encode(
  "mdbase-connect application authorization proof\0"
);
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF_ORDER = P256_ORDER / 2n;

export async function applicationInstallationId(
  identity: Pick<GrantKeyRecord, "agreementPublicKey" | "signingPublicKey">
): Promise<string> {
  const agreement = publicKey(identity.agreementPublicKey);
  const signing = publicKey(identity.signingPublicKey);
  if (equalBytes(agreement, signing)) {
    throw new Error("Application installation agreement and signing keys must be distinct.");
  }
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    concat([
      INSTALLATION_ID_DOMAIN,
      field(agreement),
      field(signing)
    ]) as BufferSource
  ));
  const id = digest.slice(0, 16);
  id[6] = (id[6]! & 0x0f) | 0x80;
  id[8] = (id[8]! & 0x3f) | 0x80;
  return [
    hex(id.slice(0, 4)),
    hex(id.slice(4, 6)),
    hex(id.slice(6, 8)),
    hex(id.slice(8, 10)),
    hex(id.slice(10, 16))
  ].join("-");
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

export function authorizationSigningMessage(
  binding: ApplicationAuthorizationBinding
): Uint8Array {
  const keys = [
    publicKey(binding.installation_agreement_public_key),
    publicKey(binding.installation_signing_public_key),
    publicKey(binding.grant_agreement_public_key),
    publicKey(binding.grant_signing_public_key)
  ];
  if (keys.some((key, index) =>
    keys.slice(index + 1).some((other) => equalBytes(key, other)))) {
    throw new Error("Application authorization keys must be distinct.");
  }
  const nonce = canonicalBase64(binding.authorization_nonce);
  const challenge = canonicalBase64(binding.code_challenge);
  if (
    binding.protocol_version !== 1
    || nonce.byteLength !== 32
    || challenge.byteLength !== 32
    || binding.requested_operations.length === 0
    || new Set(binding.requested_operations).size !== binding.requested_operations.length
    || binding.requested_operations.some((operation) => !operation || operation.includes("\0"))
    || (binding.flow === "authorization_code"
      ? binding.redirect_uri === undefined || binding.state === undefined
      : binding.flow === "device_code"
        ? binding.redirect_uri !== undefined || binding.state !== undefined
        : true)
  ) {
    throw new Error("Application authorization binding is invalid.");
  }
  const operationFields = binding.requested_operations.map((operation) =>
    field(new TextEncoder().encode(operation)));
  return concat([
    AUTHORIZATION_PROOF_DOMAIN,
    u32(binding.protocol_version),
    field(uuidBytes(binding.application_id)),
    field(uuidBytes(binding.application_installation_id)),
    ...keys.map(field),
    field(new TextEncoder().encode(binding.flow)),
    field(nonce),
    optionalString(binding.redirect_uri),
    optionalString(binding.state),
    field(new TextEncoder().encode(binding.code_challenge)),
    u32(operationFields.length),
    ...operationFields,
    optionalUuid(binding.collection_id)
  ]);
}

function optionalString(value: string | undefined): Uint8Array {
  return value === undefined
    ? new Uint8Array([0])
    : concat([new Uint8Array([1]), field(new TextEncoder().encode(value))]);
}

function optionalUuid(value: string | undefined): Uint8Array {
  return value === undefined
    ? new Uint8Array([0])
    : concat([new Uint8Array([1]), field(uuidBytes(value))]);
}

function publicKey(value: string): Uint8Array {
  const key = canonicalBase64(value);
  if (key.byteLength !== 65 || key[0] !== 4) {
    throw new Error("Application authorization public key is invalid.");
  }
  return key;
}

function canonicalBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value.");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (base64Url(decoded) !== value) throw new Error("Non-canonical base64url value.");
  return decoded;
}

function uuidBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid UUID value.");
  }
  const compact = value.replaceAll("-", "");
  return Uint8Array.from(
    { length: 16 },
    (_, index) => Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16)
  );
}

function field(value: Uint8Array): Uint8Array {
  return concat([u32(value.byteLength), value]);
}

function u32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
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
