/** Bounded MDBK v1 AWS-KMS envelope, compatible with native service custody.
 * Contains ciphertext only. Never selects an ARN outside deployment configuration.
 */
export const MAX_KEY_REF_BYTES = 2048;
export const MAX_CIPHERTEXT_BYTES = 8192;
const HEADER_BYTES = 12;
const MAGIC = [0x4d, 0x44, 0x42, 0x4b] as const;

function invalid(): never {
  throw new Error("custody_envelope_invalid");
}

function validReference(value: string): boolean {
  return value.length > 0 && value.length <= MAX_KEY_REF_BYTES &&
    /^[\x21-\x7e]+$/.test(value) && !/["\\]/.test(value);
}

export function encodeEnvelope(keyRef: string, ciphertext: Uint8Array): Uint8Array {
  if (!validReference(keyRef) || ciphertext.byteLength === 0 ||
      ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) invalid();
  // Reference is ASCII, so character and encoded byte counts are identical.
  const reference = new TextEncoder().encode(keyRef);
  const out = new Uint8Array(HEADER_BYTES + reference.byteLength + ciphertext.byteLength);
  out.set(MAGIC);
  out[4] = 1; // version
  out[5] = 1; // AWS KMS
  const view = new DataView(out.buffer);
  view.setUint16(6, reference.byteLength, false);
  view.setUint32(8, ciphertext.byteLength, false);
  out.set(reference, HEADER_BYTES);
  out.set(ciphertext, HEADER_BYTES + reference.byteLength);
  return out;
}

export function parseEnvelope(input: Uint8Array): {
  readonly keyRef: string;
  readonly ciphertext: Uint8Array;
} {
  if (input.byteLength < HEADER_BYTES ||
      input.byteLength > HEADER_BYTES + MAX_KEY_REF_BYTES + MAX_CIPHERTEXT_BYTES ||
      MAGIC.some((byte, i) => input[i] !== byte) || input[4] !== 1 || input[5] !== 1) invalid();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const referenceLength = view.getUint16(6, false);
  const ciphertextLength = view.getUint32(8, false);
  if (referenceLength === 0 || referenceLength > MAX_KEY_REF_BYTES ||
      ciphertextLength === 0 || ciphertextLength > MAX_CIPHERTEXT_BYTES ||
      input.byteLength !== HEADER_BYTES + referenceLength + ciphertextLength) invalid();
  let keyRef: string;
  try {
    keyRef = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      input.subarray(HEADER_BYTES, HEADER_BYTES + referenceLength),
    );
  } catch {
    return invalid();
  }
  if (!validReference(keyRef)) invalid();
  // Copy bounded ciphertext: mutation of the CP response across an await cannot
  // change the bytes sent to KMS after the reference has been checked.
  return { keyRef, ciphertext: input.slice(HEADER_BYTES + referenceLength) };
}

/** Return our configured ARN, never the CP record's informational ARN. */
export function configuredEnvelope(
  input: Uint8Array,
  configuredArns: readonly string[],
): { readonly keyArn: string; readonly ciphertext: Uint8Array } {
  const parsed = parseEnvelope(input);
  const keyArn = configuredArns.find((arn) => arn === parsed.keyRef);
  if (keyArn === undefined) throw new Error("custody_key_not_configured");
  return { keyArn, ciphertext: parsed.ciphertext };
}
