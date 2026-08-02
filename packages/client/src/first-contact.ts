import {
  FIRST_CONTACT_PROTOCOL_VERSION,
  type FirstContactBinding
} from "@mdbase-dev/connect-protocol";

const TRANSCRIPT_DOMAIN = new TextEncoder().encode(
  "mdbase-connect first-contact transcript\0"
);
const SAS_INFO = new TextEncoder().encode(
  "mdbase-connect first-contact sas v1"
);
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FirstContactRole = "application" | "connector";

export class FirstContactCryptoError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Derive the independently displayed first-contact authentication string.
 * The private key must belong to the endpoint role named in the transcript.
 */
export async function deriveFirstContactSas(
  binding: FirstContactBinding,
  role: FirstContactRole,
  identity: {
    agreementPrivateKey: CryptoKey;
    agreementPublicKey: string;
  }
): Promise<string> {
  const keys = await validatedKeys(binding);
  const own = role === "application"
    ? binding.application_agreement_public_key
    : binding.connector_agreement_public_key;
  const peer = role === "application"
    ? keys.connector
    : keys.applicationAgreement;
  if (identity.agreementPublicKey !== own) {
    throw new FirstContactCryptoError(
      "identity_mismatch",
      "The first-contact identity does not match the transcript."
    );
  }
  let peerKey: CryptoKey;
  try {
    peerKey = await crypto.subtle.importKey(
      "raw",
      peer as BufferSource,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
  } catch {
    throw new FirstContactCryptoError(
      "invalid_public_key",
      "The first-contact public key is invalid."
    );
  }
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerKey },
    identity.agreementPrivateKey,
    256
  );
  const transcript = firstContactTranscript(binding, keys);
  const salt = await crypto.subtle.digest("SHA-256", transcript as BufferSource);
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    shared,
    "HKDF",
    false,
    ["deriveBits"]
  );
  const sas = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: SAS_INFO },
    hkdfKey,
    40
  ));
  return formatSas(sas);
}

interface ValidatedKeys {
  applicationAgreement: Uint8Array;
  applicationSigning: Uint8Array;
  connector: Uint8Array;
}

async function validatedKeys(
  binding: FirstContactBinding
): Promise<ValidatedKeys> {
  if (binding.protocol_version !== FIRST_CONTACT_PROTOCOL_VERSION) {
    throw new FirstContactCryptoError(
      "unsupported_version",
      "The first-contact protocol version is not supported."
    );
  }
  const applicationAgreement = canonicalPublicKey(
    binding.application_agreement_public_key
  );
  const applicationSigning = canonicalPublicKey(
    binding.application_signing_public_key
  );
  const connector = canonicalPublicKey(
    binding.connector_agreement_public_key
  );
  if (
    equalBytes(applicationAgreement, applicationSigning)
    || equalBytes(applicationAgreement, connector)
    || equalBytes(applicationSigning, connector)
  ) {
    throw new FirstContactCryptoError(
      "invalid_public_key",
      "First contact requires distinct endpoint agreement and signing keys."
    );
  }
  try {
    await Promise.all([
      applicationAgreement,
      applicationSigning,
      connector
    ].map((key) => crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    )));
  } catch {
    throw new FirstContactCryptoError(
      "invalid_public_key",
      "The first-contact public key is invalid."
    );
  }
  return { applicationAgreement, applicationSigning, connector };
}

function firstContactTranscript(
  binding: FirstContactBinding,
  keys: ValidatedKeys
): Uint8Array {
  const chunks = [
    TRANSCRIPT_DOMAIN,
    u32(binding.protocol_version),
    field(uuidBytes(binding.application_id)),
    field(uuidBytes(binding.application_installation_id)),
    field(keys.applicationAgreement),
    field(keys.applicationSigning),
    field(uuidBytes(binding.connector_id)),
    field(keys.connector)
  ];
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function field(value: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + value.byteLength);
  output.set(u32(value.byteLength));
  output.set(value, 4);
  return output;
}

function u32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function uuidBytes(value: string): Uint8Array {
  if (!UUID_PATTERN.test(value)) {
    throw new FirstContactCryptoError(
      "invalid_binding",
      "The first-contact transcript contains an invalid identifier."
    );
  }
  const compact = value.replaceAll("-", "");
  return Uint8Array.from(
    { length: 16 },
    (_, index) => Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16)
  );
}

function canonicalPublicKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new FirstContactCryptoError(
      "invalid_public_key",
      "The first-contact public key is invalid."
    );
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new FirstContactCryptoError(
      "invalid_public_key",
      "The first-contact public key is invalid."
    );
  }
  if (
    bytes.byteLength !== 65
    || bytes[0] !== 4
    || base64Url(bytes) !== value
  ) {
    throw new FirstContactCryptoError(
      "invalid_public_key",
      "The first-contact public key is invalid."
    );
  }
  return bytes;
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

function formatSas(value: Uint8Array): string {
  let bits = 0n;
  for (const byte of value) bits = (bits << 8n) | BigInt(byte);
  let output = "";
  for (let index = 7; index >= 0; index -= 1) {
    output += CROCKFORD_BASE32[Number((bits >> BigInt(index * 5)) & 31n)];
    if (index === 4) output += "-";
  }
  return output;
}
