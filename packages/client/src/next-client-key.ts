import type { ApplicationAuthorizationProof } from "@mdbase-dev/connect-protocol";
import { bytesToBase64Url } from "./base64.js";
import type { MdbaseConnectOptions } from "./connect-options.js";
import type { GrantKeyRecord } from "./crypto.js";
import { connectError } from "./errors.js";

const DOMAIN = new TextEncoder().encode("mdbase-next client noise key v1\0");
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const invalid = () => connectError("invalid_application_authorization", "Invalid Next client key attestation or HTTPS control origin.");

/** Validate only the new opt-in; legacy origin/default behavior is untouched. */
export function configureNextClientKey(
  provider: MdbaseConnectOptions["nextClientKey"], serverUrl: string
): MdbaseConnectOptions["nextClientKey"] {
  if (provider === undefined) return undefined;
  // Exact canonical origin comparison also rejects empty query/fragment markers,
  // credentials and normalized-away paths before raw base-URL concatenation.
  try {
    if (typeof provider !== "function" || !serverUrl.startsWith("https://")
      || new URL(serverUrl).origin !== serverUrl.replace(/\/$/u, "")) throw invalid();
  } catch { throw invalid(); }
  return provider;
}

/** Matches control's clientNoiseKeyMessage. The UUID is the signed binding ID. */
export function nextClientKeyMessage(authorizationId: string, publicKey: Uint8Array): Uint8Array {
  if (!UUID.test(authorizationId) || publicKey.byteLength !== 32) {
    throw invalid();
  }
  const id = Uint8Array.from(authorizationId.replaceAll("-", "").match(/../gu)!, (byte) => Number.parseInt(byte, 16));
  // Fixed u32be lengths: UUID bytes16, X25519 public key32.
  return new Uint8Array([...DOMAIN, 0, 0, 0, 16, ...id, 0, 0, 0, 32, ...publicKey]);
}

/** Internal form fields; the per-grant private signer never reaches the caller. */
export async function nextAuthorizationFields(
  proof: ApplicationAuthorizationProof,
  grant: Pick<GrantKeyRecord, "signingPrivateKey">,
  provider: MdbaseConnectOptions["nextClientKey"]
): Promise<{ application_authorization: string; client_noise_key?: string }> {
  const fields = { application_authorization: JSON.stringify(proof) };
  // Preserve the old request's exact field/value and perform no additional signing.
  if (provider === undefined) return fields;
  if (proof.binding.protocol_version !== 5) {
    throw invalid();
  }
  const supplied = await provider();
  if (!(supplied instanceof Uint8Array) || supplied.byteLength !== 32 || supplied.every((byte) => byte === 0)) {
    throw invalid();
  }
  // Snapshot public bytes before asynchronous signing; never mutate caller storage.
  const publicKey = new Uint8Array(supplied);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, grant.signingPrivateKey,
    nextClientKeyMessage(proof.binding.authorization_id, publicKey) as BufferSource
  ));
  if (signature.byteLength !== 64) {
    throw invalid();
  }
  return {
    ...fields,
    client_noise_key: JSON.stringify({ public_key: bytesToBase64Url(publicKey), signature: bytesToBase64Url(signature) })
  };
}
