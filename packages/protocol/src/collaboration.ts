export const COLLABORATION_PROTOCOL_VERSION = 1 as const;
export const COLLABORATION_PROFILE = "markdown-body-yjs-v13" as const;
export const COLLABORATION_FRAME_MAGIC = "MDBC" as const;
export const COLLABORATION_FRAME_PREFIX_BYTES = 16;
export const MAX_COLLABORATION_METADATA_BYTES = 16 * 1024;
export const MAX_COLLABORATION_PAYLOAD_BYTES = 256 * 1024;
export const MAX_COLLABORATION_FRAME_BYTES = COLLABORATION_FRAME_PREFIX_BYTES
  + MAX_COLLABORATION_METADATA_BYTES
  + MAX_COLLABORATION_PAYLOAD_BYTES;

const MAGIC = new Uint8Array([0x4d, 0x44, 0x42, 0x43]);
const FLAGS = 0;

export const COLLABORATION_MESSAGE_KIND = {
  authenticate: 1,
  hello: 2,
  sync_step_1: 3,
  sync_step_2: 4,
  update: 5,
  acknowledged: 6,
  awareness: 7,
  heartbeat: 8,
  room_metadata: 9,
  epoch_changed: 10,
  error: 11
} as const;

export type CollaborationMessageKind = keyof typeof COLLABORATION_MESSAGE_KIND;

export interface CollaborationFrame {
  kind: CollaborationMessageKind;
  metadata: Record<string, unknown>;
  payload: Uint8Array;
}

export class CollaborationFrameError extends Error {
  constructor(public readonly code:
    | "collaboration_frame_invalid"
    | "collaboration_frame_too_large"
    | "collaboration_protocol_unsupported") {
    super(code);
    this.name = "CollaborationFrameError";
  }
}

export function encodeCollaborationFrame(frame: CollaborationFrame): Uint8Array {
  const kind = COLLABORATION_MESSAGE_KIND[frame.kind];
  const metadata = new TextEncoder().encode(canonicalJson(frame.metadata));
  const payload = new Uint8Array(frame.payload);
  if (
    metadata.byteLength > MAX_COLLABORATION_METADATA_BYTES
    || payload.byteLength > MAX_COLLABORATION_PAYLOAD_BYTES
  ) throw new CollaborationFrameError("collaboration_frame_too_large");
  const output = new Uint8Array(
    COLLABORATION_FRAME_PREFIX_BYTES + metadata.byteLength + payload.byteLength
  );
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(4, COLLABORATION_PROTOCOL_VERSION, false);
  view.setUint8(6, kind);
  view.setUint8(7, FLAGS);
  view.setUint32(8, metadata.byteLength, false);
  view.setUint32(12, payload.byteLength, false);
  output.set(metadata, COLLABORATION_FRAME_PREFIX_BYTES);
  output.set(payload, COLLABORATION_FRAME_PREFIX_BYTES + metadata.byteLength);
  return output;
}

export function decodeCollaborationFrame(
  input: ArrayBuffer | ArrayBufferView
): CollaborationFrame {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < COLLABORATION_FRAME_PREFIX_BYTES) return invalid();
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, false) !== COLLABORATION_PROTOCOL_VERSION) {
    throw new CollaborationFrameError("collaboration_protocol_unsupported");
  }
  if (view.getUint8(7) !== FLAGS) return invalid();
  const kindCode = view.getUint8(6);
  const kind = (Object.entries(COLLABORATION_MESSAGE_KIND) as Array<[
    CollaborationMessageKind,
    number
  ]>).find(([, code]) => code === kindCode)?.[0];
  if (!kind) return invalid();
  const metadataLength = view.getUint32(8, false);
  const payloadLength = view.getUint32(12, false);
  if (
    metadataLength > MAX_COLLABORATION_METADATA_BYTES
    || payloadLength > MAX_COLLABORATION_PAYLOAD_BYTES
  ) throw new CollaborationFrameError("collaboration_frame_too_large");
  const expected = COLLABORATION_FRAME_PREFIX_BYTES + metadataLength + payloadLength;
  if (bytes.byteLength !== expected) return invalid();
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(COLLABORATION_FRAME_PREFIX_BYTES, COLLABORATION_FRAME_PREFIX_BYTES + metadataLength)
    ));
  } catch {
    return invalid();
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return invalid();
  }
  return {
    kind,
    metadata: metadata as Record<string, unknown>,
    payload: bytes.slice(COLLABORATION_FRAME_PREFIX_BYTES + metadataLength)
  };
}

function canonicalJson(value: Record<string, unknown>): string {
  const normalized = canonicalValue(value, new WeakSet<object>());
  return JSON.stringify(normalized);
}

function canonicalValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (typeof value !== "object") return invalid();
  if (ancestors.has(value)) return invalid();
  ancestors.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    normalized = value.map((item) => canonicalValue(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    normalized = Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key], ancestors)]));
  }
  ancestors.delete(value);
  return normalized;
}

function invalid(): never {
  throw new CollaborationFrameError("collaboration_frame_invalid");
}
