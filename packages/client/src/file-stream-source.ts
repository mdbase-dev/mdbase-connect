import { connectError } from "./errors.js";

/** Converts a one-shot byte source into exact upload parts without read-ahead. */
export class BinaryPartReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private remainder: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private remainderOffset = 0;
  private maxSourceChunkBytes: number | null = null;
  private ended = false;

  constructor(source: AsyncIterable<Uint8Array>, private readonly signal?: AbortSignal) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  setMaxSourceChunkBytes(value: number): void {
    this.maxSourceChunkBytes = value;
  }

  async read(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.remainderOffset === this.remainder.byteLength) {
        throwIfAborted(this.signal);
        const next = await this.iterator.next();
        if (next.done) {
          this.ended = true;
          throw connectError(
            "invalid_request",
            "Streamed file bytes ended before the declared size."
          );
        }
        if (!(next.value instanceof Uint8Array)) {
          throw connectError("invalid_request", "A streamed file chunk was not a Uint8Array.");
        }
        if (this.maxSourceChunkBytes === null) {
          throw new Error("Stream source was read before upload negotiation completed.");
        }
        if (next.value.byteLength > this.maxSourceChunkBytes) {
          throw connectError(
            "invalid_request",
            `A streamed file chunk exceeded the negotiated ${this.maxSourceChunkBytes}-byte upload part size.`
          );
        }
        this.remainder = next.value;
        this.remainderOffset = 0;
        if (this.remainder.byteLength === 0) continue;
      }
      const count = Math.min(
        length - offset,
        this.remainder.byteLength - this.remainderOffset
      );
      output.set(
        this.remainder.subarray(this.remainderOffset, this.remainderOffset + count),
        offset
      );
      offset += count;
      this.remainderOffset += count;
    }
    return output;
  }

  async expectEnd(): Promise<void> {
    if (this.remainderOffset < this.remainder.byteLength) {
      throw connectError("invalid_request", "Streamed file bytes exceed the declared size.");
    }
    while (!this.ended) {
      throwIfAborted(this.signal);
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw connectError("invalid_request", "A streamed file chunk was not a Uint8Array.");
      }
      if (next.value.byteLength > 0) {
        throw connectError("invalid_request", "Streamed file bytes exceed the declared size.");
      }
    }
  }

  async close(): Promise<void> {
    this.ended = true;
    await this.iterator.return?.();
  }
}

export async function* streamBytes(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    const abort = () => void reader.cancel(signal?.reason).catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    let completed = false;
    try {
      throwIfAborted(signal);
      while (true) {
        const next = await reader.read();
        if (next.done) {
          completed = true;
          return;
        }
        yield next.value;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const iterable = source as AsyncIterable<Uint8Array>;
  if (typeof iterable[Symbol.asyncIterator] !== "function") {
    throw connectError("invalid_request", "Streamed files require a readable byte stream.");
  }
  for await (const chunk of iterable) {
    throwIfAborted(signal);
    yield chunk;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw connectError("operation_cancelled", "The file transfer was cancelled.", {
      operationOutcome: "not_sent",
      cause: signal.reason
    });
  }
}
