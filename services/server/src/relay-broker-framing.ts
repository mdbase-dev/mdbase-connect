import {
  createInbox,
  type Msg,
  type NatsConnection,
  type Subscription
} from "@nats-io/transport-node";

const FRAME_MAGIC = 0x4d444252; // MDBR
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 20;
const FRAME_SAFETY_BYTES = 1_024;
const PREFERRED_FRAME_BYTES = 512 * 1_024;
const MAX_FRAME_COUNT = 65_536;

export const BROKER_LOGICAL_MESSAGE_LIMIT_BYTES = 64 * 1_024 * 1_024;
const BROKER_ASSEMBLY_TIMEOUT_MS = 35_000;
const BROKER_PENDING_MESSAGE_LIMIT = 512;
const BROKER_BUFFER_LIMIT_BYTES = 256 * 1_024 * 1_024;

export type BrokerFrameKind = 1 | 2;

export interface BrokerFrameMetadata {
  kind: BrokerFrameKind;
  totalBytes: number;
  chunkIndex: number;
  chunkCount: number;
  payload: Uint8Array;
}

/**
 * Splits one logical broker message into frames that remain safely below the
 * active NATS server's payload ceiling. The logical limit is deliberately
 * independent of that deployment setting so changing brokers cannot change
 * Connect's application contract.
 */
export function encodeBrokerFrames(
  value: Uint8Array,
  kind: BrokerFrameKind,
  brokerMaxPayloadBytes: number
): Uint8Array[] {
  if (value.byteLength > BROKER_LOGICAL_MESSAGE_LIMIT_BYTES) {
    throw new BrokerFrameError("broker_message_too_large");
  }
  if (!Number.isSafeInteger(brokerMaxPayloadBytes)
      || brokerMaxPayloadBytes <= FRAME_HEADER_BYTES + FRAME_SAFETY_BYTES) {
    throw new BrokerFrameError("broker_payload_limit_invalid");
  }
  const frameBytes = Math.min(
    PREFERRED_FRAME_BYTES,
    brokerMaxPayloadBytes - FRAME_SAFETY_BYTES
  );
  const chunkBytes = frameBytes - FRAME_HEADER_BYTES;
  const chunkCount = Math.max(1, Math.ceil(value.byteLength / chunkBytes));
  if (chunkCount > MAX_FRAME_COUNT) {
    throw new BrokerFrameError("broker_message_too_fragmented");
  }

  const frames: Uint8Array[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkBytes;
    const end = Math.min(value.byteLength, start + chunkBytes);
    const payload = value.subarray(start, end);
    const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    view.setUint32(0, FRAME_MAGIC);
    view.setUint8(4, FRAME_VERSION);
    view.setUint8(5, kind);
    view.setUint16(6, 0);
    view.setUint32(8, value.byteLength);
    view.setUint32(12, index);
    view.setUint32(16, chunkCount);
    frame.set(payload, FRAME_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

export function inspectBrokerFrame(value: Uint8Array): BrokerFrameMetadata {
  if (value.byteLength < FRAME_HEADER_BYTES) {
    throw new BrokerFrameError("broker_frame_truncated");
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const kind = view.getUint8(5);
  const totalBytes = view.getUint32(8);
  const chunkIndex = view.getUint32(12);
  const chunkCount = view.getUint32(16);
  if (view.getUint32(0) !== FRAME_MAGIC
      || view.getUint8(4) !== FRAME_VERSION
      || (kind !== 1 && kind !== 2)
      || view.getUint16(6) !== 0
      || totalBytes > BROKER_LOGICAL_MESSAGE_LIMIT_BYTES
      || chunkCount < 1
      || chunkCount > MAX_FRAME_COUNT
      || chunkIndex >= chunkCount) {
    throw new BrokerFrameError("broker_frame_invalid");
  }
  const payload = value.subarray(FRAME_HEADER_BYTES);
  if ((totalBytes === 0 && (chunkCount !== 1 || payload.byteLength !== 0))
      || (totalBytes > 0 && payload.byteLength === 0)
      || payload.byteLength > totalBytes) {
    throw new BrokerFrameError("broker_frame_invalid");
  }
  return {
    kind,
    totalBytes,
    chunkIndex,
    chunkCount,
    payload
  };
}

/** Reassembles one bounded logical request or response, including out-of-order frames. */
export class BrokerFrameAssembler {
  private chunks: Array<Uint8Array | undefined> | undefined;
  private expectedKind: BrokerFrameKind | undefined;
  private expectedBytes = 0;
  private receivedChunks = 0;
  private bufferedBytes = 0;

  get receivedBytes(): number {
    return this.bufferedBytes;
  }

  accept(value: Uint8Array, expectedKind: BrokerFrameKind): Uint8Array | null {
    const frame = inspectBrokerFrame(value);
    if (frame.kind !== expectedKind) {
      throw new BrokerFrameError("broker_frame_kind_mismatch");
    }
    if (!this.chunks) {
      this.expectedKind = frame.kind;
      this.expectedBytes = frame.totalBytes;
      this.chunks = new Array(frame.chunkCount);
    } else if (this.expectedKind !== frame.kind
        || this.expectedBytes !== frame.totalBytes
        || this.chunks.length !== frame.chunkCount) {
      throw new BrokerFrameError("broker_frame_sequence_mismatch");
    }
    if (this.chunks[frame.chunkIndex]) {
      throw new BrokerFrameError("broker_frame_duplicate");
    }
    const payload = Uint8Array.from(frame.payload);
    this.chunks[frame.chunkIndex] = payload;
    this.receivedChunks += 1;
    this.bufferedBytes += payload.byteLength;
    if (this.bufferedBytes > this.expectedBytes) {
      throw new BrokerFrameError("broker_frame_length_mismatch");
    }
    if (this.receivedChunks !== this.chunks.length) return null;
    if (this.bufferedBytes !== this.expectedBytes) {
      throw new BrokerFrameError("broker_frame_length_mismatch");
    }
    const output = new Uint8Array(this.expectedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (!chunk) throw new BrokerFrameError("broker_frame_missing");
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

export class BrokerFrameError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface IncomingBrokerAssembly {
  assembler: BrokerFrameAssembler;
  timer: NodeJS.Timeout;
}

/**
 * Bounded request/reply transport over Core NATS. Each logical payload has one
 * private inbox and is fragmented below max_payload in both directions.
 */
export class NatsFramedTransport {
  private readonly incoming = new Map<string, IncomingBrokerAssembly>();
  private incomingBufferedBytes = 0;
  private responseBufferedBytes = 0;

  constructor(private readonly connection: NatsConnection) {}

  close(): void {
    for (const incoming of this.incoming.values()) clearTimeout(incoming.timer);
    this.incoming.clear();
    this.incomingBufferedBytes = 0;
  }

  request(subject: string, value: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    const frames = this.frames(value, 1);
    const inbox = createInbox();
    const assembler = new BrokerFrameAssembler();
    let settled = false;
    let subscription: Subscription | undefined;
    let timer: NodeJS.Timeout | undefined;

    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, result?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        subscription?.unsubscribe();
        this.responseBufferedBytes = Math.max(
          0,
          this.responseBufferedBytes - assembler.receivedBytes
        );
        if (error) reject(error);
        else resolve(result ?? new Uint8Array());
      };
      subscription = this.connection.subscribe(inbox, {
        callback: (error, message) => {
          if (error) {
            finish(new NatsFramedTransportError("broker_response_failed", { cause: error }));
            return;
          }
          if (message.headers?.code === 503) {
            finish(new NatsFramedTransportError("broker_no_responders"));
            return;
          }
          try {
            const metadata = inspectBrokerFrame(message.data);
            if (this.responseBufferedBytes + metadata.payload.byteLength
                > BROKER_BUFFER_LIMIT_BYTES) {
              throw new BrokerFrameError("broker_response_capacity_exceeded");
            }
            const before = assembler.receivedBytes;
            let complete: Uint8Array | null;
            try {
              complete = assembler.accept(message.data, 2);
            } finally {
              // accept() can reject only after observing an invalid cumulative
              // length. Account for any copied bytes before finish() releases
              // the assembly so concurrent capacity cannot be undercounted.
              this.responseBufferedBytes += assembler.receivedBytes - before;
            }
            if (complete) finish(null, complete);
          } catch (cause) {
            finish(new NatsFramedTransportError("broker_response_invalid", { cause }));
          }
        }
      });
      timer = setTimeout(() => {
        finish(new NatsFramedTransportError("broker_response_timeout"));
      }, timeoutMs);
      try {
        for (const frame of frames) {
          this.connection.publish(subject, frame, { reply: inbox });
        }
      } catch (cause) {
        finish(new NatsFramedTransportError("broker_request_failed", { cause }));
      }
    });
  }

  async handle(
    error: Error | null,
    message: Msg,
    handler: (value: Uint8Array) => Promise<Uint8Array>,
    failure: () => Uint8Array
  ): Promise<void> {
    if (error || !message.reply) return;
    const key = `${message.subject}\u0000${message.reply}`;
    let incoming = this.incoming.get(key);
    try {
      const metadata = inspectBrokerFrame(message.data);
      if (metadata.kind !== 1) throw new BrokerFrameError("broker_request_kind_invalid");
      if (!incoming) {
        if (this.incoming.size >= BROKER_PENDING_MESSAGE_LIMIT) {
          throw new BrokerFrameError("broker_request_capacity_exceeded");
        }
        incoming = {
          assembler: new BrokerFrameAssembler(),
          timer: setTimeout(() => this.discardIncoming(key), BROKER_ASSEMBLY_TIMEOUT_MS)
        };
        this.incoming.set(key, incoming);
      }
      if (this.incomingBufferedBytes + metadata.payload.byteLength
          > BROKER_BUFFER_LIMIT_BYTES) {
        throw new BrokerFrameError("broker_request_capacity_exceeded");
      }
      const before = incoming.assembler.receivedBytes;
      let complete: Uint8Array | null;
      try {
        complete = incoming.assembler.accept(message.data, 1);
      } finally {
        this.incomingBufferedBytes += incoming.assembler.receivedBytes - before;
      }
      if (!complete) return;
      this.discardIncoming(key);
      const reply = await handler(complete);
      this.publishResponse(message.reply, reply, failure());
    } catch {
      this.discardIncoming(key);
      this.publishResponse(message.reply, failure(), failure());
    }
  }

  private discardIncoming(key: string): void {
    const incoming = this.incoming.get(key);
    if (!incoming) return;
    clearTimeout(incoming.timer);
    this.incoming.delete(key);
    this.incomingBufferedBytes = Math.max(
      0,
      this.incomingBufferedBytes - incoming.assembler.receivedBytes
    );
  }

  private publishResponse(subject: string, value: Uint8Array, failure: Uint8Array): void {
    let frames: Uint8Array[];
    try {
      frames = this.frames(value, 2);
    } catch {
      try {
        frames = this.frames(failure, 2);
      } catch {
        return;
      }
    }
    try {
      for (const frame of frames) this.connection.publish(subject, frame);
    } catch {
      // A disconnected broker makes the requester time out; it must never crash
      // the HTTP process that happens to own this connector session.
    }
  }

  private frames(value: Uint8Array, kind: BrokerFrameKind): Uint8Array[] {
    const maxPayload = this.connection.info?.max_payload;
    if (!maxPayload) throw new BrokerFrameError("broker_payload_limit_unavailable");
    return encodeBrokerFrames(value, kind, maxPayload);
  }
}

export class NatsFramedTransportError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
  }
}
