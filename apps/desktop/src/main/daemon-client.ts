import { createConnection, type Socket } from "node:net";

/**
 * Client for the mdbase daemon's control protocol, version 1
 * (mdbase-next `crates/daemon/src/control.rs`).
 *
 * Framing: `u32be(length) ‖ JSON`, at most 1 MiB per frame.
 *   request   {"v":1, "id":7, "method":"status", "params":{...}}
 *   response  {"v":1, "id":7, "result":...} | {"v":1, "id":7, "error":{code,message,reason?}}
 *   push      {"v":1, "push":"status", "payload":...}   (after status.subscribe)
 *
 * This connection is never privileged: the control key stays in the OS keychain and
 * privileged methods go through the installed runtime's CLI (`daemon-cli.ts`).
 */

export const CONTROL_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

export type DaemonEndpoint = { kind: "unix"; path: string } | { kind: "pipe"; path: string };

export class DaemonControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reason?: string
  ) {
    super(message);
    this.name = "DaemonControlError";
  }
}

/** `net.connect` target for a daemon endpoint (a socket path or a `\\.\pipe\…` name). */
export function endpointAddress(endpoint: DaemonEndpoint): string {
  return endpoint.path;
}

export function parseEndpoint(value: unknown): DaemonEndpoint {
  const v = value as { kind?: unknown; path?: unknown } | null;
  if (!v || (v.kind !== "unix" && v.kind !== "pipe") || typeof v.path !== "string" || !v.path) {
    throw new Error("The mdbase daemon reported an invalid control endpoint.");
  }
  if (v.kind === "pipe" && !v.path.startsWith("\\\\.\\pipe\\")) {
    throw new Error("The mdbase daemon reported an invalid named pipe.");
  }
  return { kind: v.kind, path: v.path };
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new DaemonControlError("invalid", "Control request is too large.");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder; throws on an oversized or malformed frame. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new DaemonControlError("protocol", "The mdbase daemon sent an oversized frame.");
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      frames.push(JSON.parse(body.toString("utf8")));
    }
    return frames;
  }
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type PushListener = (type: string, payload: unknown) => void;

/**
 * One control connection. Requests are multiplexed by ID. Pushes (after
 * `status.subscribe`) go to listeners. Any protocol violation or disconnect fails
 * every pending request and closes the connection; callers reconnect.
 */
export class DaemonConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<PushListener>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const frame of frames) this.dispatch(frame);
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new DaemonControlError("unavailable", "The mdbase daemon closed the connection.")));
  }

  static connect(endpoint: DaemonEndpoint, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DaemonConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(endpointAddress(endpoint));
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DaemonControlError("unavailable", "The mdbase daemon did not accept the connection in time."));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolve(new DaemonConnection(socket));
      });
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", onError);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.closed) {
      return Promise.reject(new DaemonControlError("unavailable", "The mdbase daemon connection is closed."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonControlError("unavailable", `The mdbase daemon did not answer ${method} in time.`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.socket.write(encodeFrame({ v: CONTROL_PROTOCOL, id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onPush(listener: PushListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.end();
    this.fail();
  }

  private dispatch(frame: unknown): void {
    const f = frame as {
      v?: unknown; id?: unknown; result?: unknown; push?: unknown; payload?: unknown;
      error?: { code?: unknown; message?: unknown; reason?: unknown };
    } | null;
    if (!f || typeof f !== "object" || f.v !== CONTROL_PROTOCOL) {
      const upgrade = f?.error?.code === "upgrade_required" || f?.error?.reason === "upgrade_required";
      this.fail(new DaemonControlError(
        upgrade ? "upgrade_required" : "protocol",
        upgrade
          ? "The mdbase daemon uses a different control protocol; update the app."
          : "The mdbase daemon sent an invalid frame."
      ));
      return;
    }
    if (typeof f.push === "string") {
      for (const listener of this.listeners) listener(f.push, f.payload);
      return;
    }
    if (typeof f.id !== "number") {
      this.fail(new DaemonControlError("protocol", "The mdbase daemon sent a response without an ID."));
      return;
    }
    const pending = this.pending.get(f.id);
    if (!pending) return; // Timed out earlier.
    this.pending.delete(f.id);
    clearTimeout(pending.timer);
    if (f.error) {
      pending.reject(new DaemonControlError(
        typeof f.error.code === "string" ? f.error.code : "internal",
        typeof f.error.message === "string" ? f.error.message : "The mdbase daemon rejected the request.",
        typeof f.error.reason === "string" ? f.error.reason : undefined
      ));
    } else {
      pending.resolve(f.result);
    }
  }

  private fail(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    const failure = error ?? new DaemonControlError("unavailable", "The mdbase daemon connection is closed.");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      this.pending.delete(id);
    }
    for (const listener of this.closeListeners) listener(error);
    this.listeners.clear();
    this.closeListeners.clear();
  }
}

/** One request on a fresh connection. */
export async function requestDaemon<T = unknown>(
  endpoint: DaemonEndpoint,
  method: string,
  params: unknown = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const connection = await DaemonConnection.connect(endpoint, timeoutMs);
  try {
    return await connection.request<T>(method, params, timeoutMs);
  } finally {
    connection.close();
  }
}

/** Not running (no endpoint) rather than refusing. */
export function daemonNotRunning(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}
