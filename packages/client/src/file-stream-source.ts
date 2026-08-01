import { connectError } from "./errors.js";

/** Converts a one-shot byte source into exact upload parts without read-ahead. */
export class BinaryPartReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private remainder: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private remainderOffset = 0;
  private maxSourceChunkBytes: number | null = null;
  private iteratorClosing = false;
  private ended = false;

  constructor(
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    private readonly signal?: AbortSignal
  ) {
    this.iterator = sourceIterator(source);
  }

  setMaxSourceChunkBytes(value: number): void {
    this.maxSourceChunkBytes = value;
  }

  async read(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.remainderOffset === this.remainder.byteLength) {
        const next = await this.nextSourceChunk();
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
      const next = await this.nextSourceChunk();
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
    this.closeIterator();
  }

  private async nextSourceChunk(): Promise<IteratorResult<Uint8Array>> {
    throwIfAborted(this.signal);
    const pending = this.iterator.next();
    const signal = this.signal;
    if (!signal) return pending;

    let removeAbortListener = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => {
        this.closeIterator();
        reject(cancelledError(signal));
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    });
    try {
      const next = await Promise.race([pending, cancelled]);
      throwIfAborted(signal);
      return next;
    } finally {
      removeAbortListener();
    }
  }

  private closeIterator(): void {
    if (this.iteratorClosing) return;
    this.iteratorClosing = true;
    try {
      const closing = this.iterator.return?.();
      void closing?.catch(() => undefined);
    } catch {
      // Cancellation and transfer cleanup must not wait for a broken source.
    }
  }
}

function sourceIterator(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
): AsyncIterator<Uint8Array> {
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        reader.releaseLock();
      }
    };
    return {
      async next() {
        if (released) return { done: true, value: undefined };
        const next = await reader.read();
        if (next.done) release();
        return next;
      },
      async return() {
        if (!released) {
          try {
            await reader.cancel();
          } finally {
            release();
          }
        }
        return { done: true, value: undefined };
      }
    };
  }
  const iterable = source as AsyncIterable<Uint8Array>;
  if (typeof iterable[Symbol.asyncIterator] !== "function") {
    throw connectError("invalid_request", "Streamed files require a readable byte stream.");
  }
  return iterable[Symbol.asyncIterator]();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError(signal);
}

function cancelledError(signal?: AbortSignal) {
  return connectError("operation_cancelled", "The file transfer was cancelled.", {
    operationOutcome: "not_sent",
    cause: signal?.reason
  });
}
