import {
  mutationOperationIdentifier,
  operationInputSchemaVersion,
  type EncryptedOperation
} from "./operations.js";

export const MUTATION_FINGERPRINT_SCHEMA_VERSION = 1 as const;
export const MUTATION_FINGERPRINT_DOMAIN = "mdbase-connect mutation fingerprint v1\0" as const;

const encoder = new TextEncoder();

export function canonicalMutationInput(input: unknown): string {
  return canonicalize(input, new Set<object>());
}

export function mutationFingerprintTranscript(
  operation: EncryptedOperation,
  input: unknown
): Uint8Array<ArrayBuffer> {
  const identifier = mutationOperationIdentifier(operation, input);
  if (identifier === null) throw new TypeError("The operation is not a canonical mutation.");
  const identifierBytes = encoder.encode(identifier);
  const inputBytes = encoder.encode(canonicalMutationInput(input));
  const domainBytes = encoder.encode(MUTATION_FINGERPRINT_DOMAIN);
  const transcript = new Uint8Array(
    domainBytes.length + 4 + 8 + identifierBytes.length + 4 + 8 + inputBytes.length
  );
  const view = new DataView(transcript.buffer);
  let offset = 0;
  transcript.set(domainBytes, offset);
  offset += domainBytes.length;
  view.setUint32(offset, MUTATION_FINGERPRINT_SCHEMA_VERSION, false);
  offset += 4;
  offset = writeField(transcript, view, offset, identifierBytes);
  view.setUint32(offset, operationInputSchemaVersion(operation, input), false);
  offset += 4;
  writeField(transcript, view, offset, inputBytes);
  return transcript;
}

export async function mutationFingerprint(
  operation: EncryptedOperation,
  input: unknown
): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      mutationFingerprintTranscript(operation, input).buffer
    )
  );
  return base64Url(digest);
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Mutation input numbers must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Mutation input contains unsupported ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new TypeError("Mutation input must not contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("Mutation input must not contain symbol properties.");
      }
      const children: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("Mutation input arrays must not be sparse.");
        children.push(canonicalize(value[index], ancestors));
      }
      return `[${children.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Mutation input objects must be plain JSON objects.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Mutation input must not contain symbol properties.");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key] of entries) assertUnicodeScalarString(key);
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, child]) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new TypeError("Mutation input must not contain accessor properties.");
      }
      return `${JSON.stringify(key)}:${canonicalize(child, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Mutation input strings must not contain lone surrogates.");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Mutation input strings must not contain lone surrogates.");
    }
  }
}

function writeField(
  transcript: Uint8Array,
  view: DataView,
  offset: number,
  value: Uint8Array
): number {
  view.setBigUint64(offset, BigInt(value.length), false);
  offset += 8;
  transcript.set(value, offset);
  return offset + value.length;
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
