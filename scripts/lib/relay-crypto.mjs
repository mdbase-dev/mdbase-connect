import {
  applicationInstallationIdFromPublicKey,
  authorizationSigningMessage
} from "../../packages/protocol/dist/index.js";

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const P256_HALF_ORDER = P256_ORDER / 2n;

export class MemoryGrantKeyStore {
  #records = new Map();

  async create(handle) {
    if (this.#records.has(handle)) throw new Error(`Grant key already exists: ${handle}`);
    const agreement = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const agreementPublicKey = Buffer.from(
      await crypto.subtle.exportKey("raw", agreement.publicKey)
    ).toString("base64url");
    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const signingPublicKey = Buffer.from(
      await crypto.subtle.exportKey("raw", signing.publicKey)
    ).toString("base64url");
    const record = {
      handle,
      agreementPrivateKey: agreement.privateKey,
      agreementPublicKey,
      signingPrivateKey: signing.privateKey,
      signingPublicKey
    };
    this.#records.set(handle, record);
    return record;
  }

  async get(handle) {
    return this.#records.get(handle) ?? null;
  }

  async delete(handle) {
    this.#records.delete(handle);
  }
}

export async function applicationInstallationId(identity) {
  return applicationInstallationIdFromPublicKey(identity.signingPublicKey);
}

export async function signApplicationAuthorization(binding, identity) {
  if (
    binding.installation_signing_public_key !== identity.signingPublicKey
    || binding.application_installation_id !== await applicationInstallationId(identity)
  ) {
    throw new Error("Application authorization identity does not match its binding.");
  }
  const raw = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.signingPrivateKey,
    authorizationSigningMessage(binding)
  ));
  if (raw.byteLength !== 64) throw new Error("Application authorization signature is invalid.");
  const s = BigInt(`0x${Buffer.from(raw.subarray(32)).toString("hex")}`);
  if (s === 0n || s >= P256_ORDER) throw new Error("Application authorization signature is invalid.");
  const signature = s <= P256_HALF_ORDER
    ? raw
    : Uint8Array.from(Buffer.concat([
        raw.subarray(0, 32),
        Buffer.from((P256_ORDER - s).toString(16).padStart(64, "0"), "hex")
      ]));
  return { binding, signature: Buffer.from(signature).toString("base64url") };
}
