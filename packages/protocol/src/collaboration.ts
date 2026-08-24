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

export interface ReplicaCollaborationCapability {
  contract_version: 1;
  profiles: [typeof COLLABORATION_PROFILE];
  access: "read_only" | "read_write";
}

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

// ---------------------------------------------------------------------------
// Strict ephemeral awareness wire types.
//
// Awareness is server-sanitized presentation state scoped to one provider
// instance. Clients send an empty-payload Awareness frame whose metadata is
// exactly {status, selections}; the server broadcasts complete replacement
// snapshots of exactly {participants}. Names, colors, and every other
// identity field are assigned from the authenticated control-plane user and
// are never accepted from clients.
// ---------------------------------------------------------------------------

export const AWARENESS_PROTOCOL_VERSION = 1 as const;
export const AWARENESS_SCOPE_PROVIDER_INSTANCE = "provider_instance" as const;
export const MAX_AWARENESS_PARTICIPANTS = 16;
export const MAX_AWARENESS_SELECTIONS = 4;
export const MAX_AWARENESS_UPDATES_PER_SECOND = 8;
export const MIN_AWARENESS_UPDATE_SPACING_MS = 125;
export const AWARENESS_VISIBLE_TTL_SECONDS = 30;
export const MAX_AWARENESS_NAME_SCALARS = 100;
export const MAX_AWARENESS_NAME_BYTES = 400;

export type AwarenessStatus = "active" | "idle";

export type AwarenessColorName =
  | "blue"
  | "teal"
  | "green"
  | "amber"
  | "orange"
  | "rose"
  | "violet"
  | "slate";

export const AWARENESS_COLORS: readonly AwarenessColorName[] = [
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "violet",
  "slate"
];

export interface AwarenessSelectionRange {
  anchor: number;
  head: number;
}

export interface ClientAwarenessUpdate {
  status: AwarenessStatus;
  selections: AwarenessSelectionRange[];
}

export interface AwarenessParticipant {
  name: string;
  color: AwarenessColorName;
  status: AwarenessStatus;
  selections: AwarenessSelectionRange[];
}

export interface ServerAwarenessSnapshot {
  participants: AwarenessParticipant[];
}

export interface AwarenessHelloAdvertisement {
  version: typeof AWARENESS_PROTOCOL_VERSION;
  scope: typeof AWARENESS_SCOPE_PROVIDER_INSTANCE;
  max_participants: number;
  max_selections: number;
  max_updates_per_second: number;
  ttl_seconds: number;
}

export class AwarenessMetadataError extends Error {
  constructor(public readonly code:
    | "awareness_shape_invalid"
    | "awareness_too_many_selections"
    | "awareness_duplicate_selection"
    | "awareness_position_out_of_range"
    | "awareness_too_many_participants"
    | "awareness_name_invalid"
    | "awareness_payload_not_empty") {
    super(code);
    this.name = "AwarenessMetadataError";
  }
}

function shapeInvalid(): never {
  throw new AwarenessMetadataError("awareness_shape_invalid");
}

/** Exact-key object check: no missing keys, no unknown keys, plain object. */
function exactKeys(
  value: unknown,
  expected: readonly string[]
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return shapeInvalid();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== expected.length) return shapeInvalid();
  for (const key of expected) {
    if (!(key in record)) return shapeInvalid();
  }
  return record;
}

function parseOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)
    || value < 0 || value > 0xFFFFFFFF) {
    return shapeInvalid() as never;
  }
  return value;
}

function parseSelections(value: unknown): AwarenessSelectionRange[] {
  if (!Array.isArray(value)) return shapeInvalid();
  if (value.length > MAX_AWARENESS_SELECTIONS) {
    throw new AwarenessMetadataError("awareness_too_many_selections");
  }
  const parsed: AwarenessSelectionRange[] = [];
  for (const entry of value) {
    const range = exactKeys(entry, ["anchor", "head"]);
    const selection = { anchor: parseOffset(range.anchor), head: parseOffset(range.head) };
    if (parsed.some((existing) =>
      existing.anchor === selection.anchor && existing.head === selection.head
    )) {
      throw new AwarenessMetadataError("awareness_duplicate_selection");
    }
    parsed.push(selection);
  }
  return parsed;
}

/**
 * Parse a client Awareness frame metadata strictly. Unknown, deep, identity,
 * textual, or path fields reject; the frame payload must be empty.
 */
export function parseClientAwarenessMetadata(
  metadata: Record<string, unknown>,
  payload: Uint8Array,
  maxPosition: number
): ClientAwarenessUpdate {
  if (payload.byteLength !== 0) {
    throw new AwarenessMetadataError("awareness_payload_not_empty");
  }
  const exact = exactKeys(metadata, ["status", "selections"]);
  if (exact.status !== "active" && exact.status !== "idle") return shapeInvalid();
  const update: ClientAwarenessUpdate = {
    status: exact.status,
    selections: parseSelections(exact.selections)
  };
  validateAwarenessPositions(update.selections, maxPosition);
  return update;
}

export function encodeClientAwarenessMetadata(update: ClientAwarenessUpdate): Record<string, unknown> {
  if (update.status !== "active" && update.status !== "idle") return shapeInvalid();
  const selections = parseSelections(update.selections);
  return { status: update.status, selections };
}

function validateAwarenessPositions(
  selections: AwarenessSelectionRange[],
  maxPosition: number
): void {
  for (const selection of selections) {
    if (selection.anchor > maxPosition || selection.head > maxPosition) {
      throw new AwarenessMetadataError("awareness_position_out_of_range");
    }
  }
}

/**
 * Validate a server-assigned display name: non-empty, trimmed, NFC, free of
 * control characters and bidirectional overrides, within both budgets.
 * Mirrors the Rust `validate_awareness_name` exactly.
 */
export function isValidAwarenessDisplayName(name: string): boolean {
  if (name.length === 0 || name.trim() !== name) return false;
  if (name.normalize("NFC") !== name) return false;
  if ([...name].length > MAX_AWARENESS_NAME_SCALARS) return false;
  if (new TextEncoder().encode(name).byteLength > MAX_AWARENESS_NAME_BYTES) return false;
  for (const character of name) {
    const code = character.codePointAt(0)!;
    const isControl = code <= 0x1F || (code >= 0x7F && code <= 0x9F);
    const isBidiOverride = (code >= 0x202A && code <= 0x202E)
      || (code >= 0x2066 && code <= 0x2069);
    if (isControl || isBidiOverride) return false;
  }
  return true;
}

/**
 * Build snapshot metadata strictly. Duplicate names and colors are allowed;
 * everything else is bounded and validated.
 */
export function encodeAwarenessSnapshotMetadata(
  snapshot: ServerAwarenessSnapshot
): Record<string, unknown> {
  if (snapshot.participants.length > MAX_AWARENESS_PARTICIPANTS) {
    throw new AwarenessMetadataError("awareness_too_many_participants");
  }
  const participants = snapshot.participants.map((participant) => {
    if (!isValidAwarenessDisplayName(participant.name)) {
      throw new AwarenessMetadataError("awareness_name_invalid");
    }
    if (!AWARENESS_COLORS.includes(participant.color)) return shapeInvalid();
    if (participant.status !== "active" && participant.status !== "idle") {
      return shapeInvalid();
    }
    return {
      name: participant.name,
      color: participant.color,
      status: participant.status,
      selections: parseSelections(participant.selections)
    };
  });
  return { participants };
}

/** Parse and validate a complete replacement snapshot from frame metadata. */
export function parseAwarenessSnapshotMetadata(
  metadata: Record<string, unknown>,
  maxPosition: number
): ServerAwarenessSnapshot {
  const exact = exactKeys(metadata, ["participants"]);
  if (!Array.isArray(exact.participants)) return shapeInvalid();
  if (exact.participants.length > MAX_AWARENESS_PARTICIPANTS) {
    throw new AwarenessMetadataError("awareness_too_many_participants");
  }
  const participants = exact.participants.map((entry) => {
    const record = exactKeys(entry, ["name", "color", "status", "selections"]);
    if (typeof record.name !== "string"
      || !isValidAwarenessDisplayName(record.name)) {
      throw new AwarenessMetadataError("awareness_name_invalid");
    }
    if (typeof record.color !== "string"
      || !AWARENESS_COLORS.includes(record.color as AwarenessColorName)) {
      return shapeInvalid();
    }
    if (record.status !== "active" && record.status !== "idle") return shapeInvalid();
    const participant: AwarenessParticipant = {
      name: record.name,
      color: record.color as AwarenessColorName,
      status: record.status,
      selections: parseSelections(record.selections)
    };
    return participant;
  });
  const snapshot: ServerAwarenessSnapshot = { participants };
  for (const participant of snapshot.participants) {
    validateAwarenessPositions(participant.selections, maxPosition);
  }
  return snapshot;
}

/** Exact Hello advertisement. `provider_instance` scope is load-bearing. */
export function awarenessHelloAdvertisement(): AwarenessHelloAdvertisement {
  return {
    version: AWARENESS_PROTOCOL_VERSION,
    scope: AWARENESS_SCOPE_PROVIDER_INSTANCE,
    max_participants: MAX_AWARENESS_PARTICIPANTS,
    max_selections: MAX_AWARENESS_SELECTIONS,
    max_updates_per_second: MAX_AWARENESS_UPDATES_PER_SECOND,
    ttl_seconds: AWARENESS_VISIBLE_TTL_SECONDS
  };
}
