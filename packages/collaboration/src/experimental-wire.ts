import {
  AWARENESS_PROTOCOL_VERSION,
  AWARENESS_SCOPE_PROVIDER_INSTANCE,
  MAX_AWARENESS_PARTICIPANTS,
  MAX_AWARENESS_SELECTIONS,
  MAX_AWARENESS_UPDATES_PER_SECOND,
  MAX_COLLABORATION_PAYLOAD_BYTES,
  type CollaborationFrame,
  decodeCollaborationFrame
} from "@mdbase-dev/connect-protocol";
import { MARKDOWN_BODY_YJS_V13_PROFILE } from "./profile.js";
import type {
  ExperimentalCollaborationMode,
  ExperimentalWebSocketEvent
} from "./experimental-room.js";

export interface ExperimentalTicketRequest {
  path: string;
  mode?: ExperimentalCollaborationMode;
  epoch?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExperimentalTicket {
  ticket: string;
  webSocketUrl: string;
  expiresAt: string;
  profile: typeof MARKDOWN_BODY_YJS_V13_PROFILE;
  mode: ExperimentalCollaborationMode;
  epoch: number;
}

export interface ExperimentalHostedBridge {
  issueTicket(request: ExperimentalTicketRequest): Promise<ExperimentalTicket>;
}

export const EXPERIMENTAL_HOSTED_COLLABORATION_SYMBOL = Symbol.for(
  "mdbase.connect.experimental-hosted-collaboration.v1"
);

export function discoverExperimentalBridge(connection: unknown): ExperimentalHostedBridge {
  if ((typeof connection !== "object" && typeof connection !== "function") || connection === null) {
    throw new TypeError("Experimental hosted collaboration is unavailable.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    connection,
    EXPERIMENTAL_HOSTED_COLLABORATION_SYMBOL
  );
  const bridge = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (!descriptor || descriptor.enumerable || descriptor.configurable || descriptor.writable
      || !isExactObject(bridge, ["issueTicket"]) || !Object.isFrozen(bridge)
      || typeof bridge.issueTicket !== "function") {
    throw new TypeError("Experimental hosted collaboration is unavailable.");
  }
  return bridge as unknown as ExperimentalHostedBridge;
}

export function validateTicket(value: unknown): ExperimentalTicket {
  const ticket = exactObject(value, [
    "ticket", "webSocketUrl", "expiresAt", "profile", "mode", "epoch"
  ]);
  if (typeof ticket.ticket !== "string" || ticket.ticket.length === 0
      || typeof ticket.webSocketUrl !== "string" || ticket.webSocketUrl.length === 0
      || typeof ticket.expiresAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(ticket.expiresAt)
      || !Number.isFinite(Date.parse(ticket.expiresAt))
      || Date.parse(ticket.expiresAt) <= Date.now()
      || ticket.profile !== MARKDOWN_BODY_YJS_V13_PROFILE
      || (ticket.mode !== "read_only" && ticket.mode !== "read_write")
      || !positiveSafeInteger(ticket.epoch)) throw new Error("collaboration_ticket_invalid");
  try {
    const url = new URL(ticket.webSocketUrl);
    if ((url.protocol !== "ws:" && url.protocol !== "wss:")
        || url.pathname !== "/v1/collaboration"
        || url.username
        || url.password
        || url.search
        || url.hash) throw new Error();
  } catch {
    throw new Error("collaboration_ticket_invalid");
  }
  return ticket as unknown as ExperimentalTicket;
}

export function decodeBinaryEvent(event: ExperimentalWebSocketEvent): CollaborationFrame {
  const data = event.data;
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
    throw new Error("collaboration_binary_frame_required");
  }
  return decodeCollaborationFrame(data);
}

export interface ValidHello {
  mode: ExperimentalCollaborationMode;
  epoch: number;
  maxUpdateBytes: number;
}

export function validateHello(frame: CollaborationFrame, ticket: ExperimentalTicket): ValidHello {
  if (frame.kind !== "hello" || frame.payload.byteLength !== 0) return invalid("collaboration_hello_invalid");
  const metadata = exactObject(frame.metadata, ["profile", "mode", "epoch", "limits", "awareness"]);
  const limits = exactObject(metadata.limits, ["max_update_bytes"]);
  const awareness = exactObject(metadata.awareness, [
    "version", "scope", "max_participants", "max_selections", "max_updates_per_second", "ttl_seconds"
  ]);
  if (metadata.profile !== ticket.profile || metadata.mode !== ticket.mode || metadata.epoch !== ticket.epoch
      || !positiveSafeInteger(limits.max_update_bytes)
      || limits.max_update_bytes > MAX_COLLABORATION_PAYLOAD_BYTES
      || awareness.version !== AWARENESS_PROTOCOL_VERSION
      || awareness.scope !== AWARENESS_SCOPE_PROVIDER_INSTANCE
      || awareness.max_participants !== MAX_AWARENESS_PARTICIPANTS
      || awareness.max_selections !== MAX_AWARENESS_SELECTIONS
      || awareness.max_updates_per_second !== MAX_AWARENESS_UPDATES_PER_SECOND
      || !positiveSafeInteger(awareness.ttl_seconds)) return invalid("collaboration_hello_invalid");
  return {
    mode: metadata.mode as ExperimentalCollaborationMode,
    epoch: metadata.epoch as number,
    maxUpdateBytes: limits.max_update_bytes as number
  };
}

export function exactEmptyFrame(frame: CollaborationFrame, kind: CollaborationFrame["kind"]): boolean {
  return frame.kind === kind && frame.payload.byteLength === 0
    && isExactObject(frame.metadata, []);
}

export function exactUpdateMetadata(frame: CollaborationFrame, epoch: number): boolean {
  return isExactObject(frame.metadata, ["profile", "epoch"])
    && frame.metadata.profile === MARKDOWN_BODY_YJS_V13_PROFILE
    && frame.metadata.epoch === epoch;
}

export function exactAcknowledgement(
  frame: CollaborationFrame
): { clientMutationId: string; sequence: number; recordSequence: number } {
  if (frame.kind !== "acknowledged" || frame.payload.byteLength !== 0) {
    return invalid("collaboration_ack_invalid");
  }
  const metadata = exactObject(frame.metadata, [
    "client_mutation_id", "sequence", "record_sequence"
  ]);
  if (typeof metadata.client_mutation_id !== "string"
      || !positiveSafeInteger(metadata.sequence)
      || !positiveSafeInteger(metadata.record_sequence)) return invalid("collaboration_ack_invalid");
  return {
    clientMutationId: metadata.client_mutation_id,
    sequence: metadata.sequence as number,
    recordSequence: metadata.record_sequence as number
  };
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isExactObject(value, keys)) throw new Error("collaboration_metadata_invalid");
  return value;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value as object);
  return actual.length === keys.length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key));
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalid(code: string): never {
  throw new Error(code);
}
