import {
  MAX_COLLABORATION_PAYLOAD_BYTES,
  MIN_AWARENESS_UPDATE_SPACING_MS,
  encodeClientAwarenessMetadata,
  encodeCollaborationFrame,
  parseAwarenessSnapshotMetadata,
  parseClientAwarenessMetadata,
  type ClientAwarenessUpdate,
  type CollaborationFrame,
  type ServerAwarenessSnapshot
} from "@mdbase-dev/connect-protocol";
import * as Y from "yjs";
import { BODY_ROOT, markdownBody } from "./profile.js";
import type {
  ExperimentalHostedAwarenessState,
  ExperimentalHostedMarkdownRoom,
  ExperimentalHostedMarkdownRoomListener,
  ExperimentalHostedMarkdownRoomOptions,
  ExperimentalHostedMarkdownRoomSnapshot,
  ExperimentalHostedRoomProblem,
  ExperimentalHostedRoomState,
  ExperimentalWebSocketEvent,
  ExperimentalWebSocketFactory,
  ExperimentalWebSocketLike
} from "./experimental-room.js";
import {
  decodeBinaryEvent,
  discoverExperimentalBridge,
  exactAcknowledgement,
  exactEmptyFrame,
  exactUpdateMetadata,
  validateHello,
  validateTicket,
  type ExperimentalHostedBridge,
  type ExperimentalTicket
} from "./experimental-wire.js";

const REMOTE_ORIGIN = Object.freeze({ hostedCollaborationRemote: true });
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 8_000;
const SAFE_CLOSE_CODE = 1008;
const MAX_PENDING_UPDATES = 1_024;
const MAX_PENDING_UPDATE_BYTES = 16 * 1024 * 1024;
const MAX_ACKNOWLEDGED_IDS = 256;

type Phase = "ticket" | "opening" | "hello" | "sync" | "connected";
type Timer = ReturnType<typeof setTimeout>;

interface PendingUpdate {
  readonly id: string;
  readonly bytes: Uint8Array;
}

interface Attempt {
  readonly number: number;
  readonly ticket: ExperimentalTicket;
  readonly socket: ExperimentalWebSocketLike;
  phase: Phase;
  listeners: {
    open: (event: ExperimentalWebSocketEvent) => void;
    message: (event: ExperimentalWebSocketEvent) => void;
    close: (event: ExperimentalWebSocketEvent) => void;
    error: (event: ExperimentalWebSocketEvent) => void;
  };
}

export function openExperimentalHostedMarkdownRoom(
  connection: unknown,
  options: ExperimentalHostedMarkdownRoomOptions
): ExperimentalHostedMarkdownRoom {
  return new HostedMarkdownRoom(discoverExperimentalBridge(connection), options);
}

class HostedMarkdownRoom implements ExperimentalHostedMarkdownRoom {
  readonly doc = new Y.Doc();
  readonly body = this.doc.getText(BODY_ROOT);
  readonly undoManager = new Y.UndoManager(this.body);

  private currentSnapshot: ExperimentalHostedMarkdownRoomSnapshot;
  private readonly listeners = new Set<ExperimentalHostedMarkdownRoomListener>();
  private readonly pending: PendingUpdate[] = [];
  private readonly acknowledged = new Set<string>();
  private readonly acknowledgedOrder: string[] = [];
  private pendingBytes = 0;
  private readonly flushWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private participants: ServerAwarenessSnapshot["participants"] = [];
  private desiredAwareness?: ClientAwarenessUpdate;
  private deferredAwareness?: CollaborationFrame;
  private attempt?: Attempt;
  private attemptNumber = 0;
  private reconnectCount = 0;
  private reconnectTimer?: Timer;
  private heartbeatTimer?: Timer;
  private awarenessTimer?: Timer;
  private heartbeatPending = false;
  private updateInFlight = false;
  private lastAwarenessSent = Number.NEGATIVE_INFINITY;
  private state: ExperimentalHostedRoomState = "connecting";
  private mode?: "read_only" | "read_write";
  private epoch?: number;
  private ticketEpoch?: number;
  private maxUpdateBytes = MAX_COLLABORATION_PAYLOAD_BYTES;
  private terminal = false;
  private readonly heartbeatMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly awarenessThrottleMs: number;
  private readonly ticketTimeoutMs?: number;
  private readonly randomUUID: () => string;
  private readonly webSocketFactory: ExperimentalWebSocketFactory;
  private readonly abortListener: () => void;

  constructor(
    private readonly bridge: ExperimentalHostedBridge,
    private readonly options: ExperimentalHostedMarkdownRoomOptions
  ) {
    if (typeof options.path !== "string" || options.path.length === 0
        || !Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0) {
      throw new TypeError("Invalid experimental hosted collaboration options.");
    }
    this.heartbeatMs = positiveTiming(options.timing?.heartbeatMs, DEFAULT_HEARTBEAT_MS);
    this.reconnectBaseMs = positiveTiming(options.timing?.reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS);
    this.reconnectMaxMs = Math.max(
      this.reconnectBaseMs,
      positiveTiming(options.timing?.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS)
    );
    this.awarenessThrottleMs = Math.max(
      MIN_AWARENESS_UPDATE_SPACING_MS,
      positiveTiming(options.timing?.awarenessThrottleMs, MIN_AWARENESS_UPDATE_SPACING_MS)
    );
    this.ticketTimeoutMs = options.timing?.ticketTimeoutMs;
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.webSocketFactory = options.webSocketFactory ?? nativeWebSocketFactory;
    this.abortListener = () => this.close();
    options.signal?.addEventListener("abort", this.abortListener, { once: true });
    this.doc.on("update", this.onDocumentUpdate);
    this.currentSnapshot = this.makeSnapshot();
    if (options.signal?.aborted) this.close();
    else void this.connect(false);
  }

  get snapshot(): ExperimentalHostedMarkdownRoomSnapshot {
    return this.currentSnapshot;
  }

  subscribe(listener: ExperimentalHostedMarkdownRoomListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setAwareness(update: ExperimentalHostedAwarenessState): void {
    if (this.terminal) throw new Error("collaboration_room_closed");
    const requested: ClientAwarenessUpdate = {
      status: update.status,
      selections: update.selections.map((selection) => ({ ...selection }))
    };
    const metadata = encodeClientAwarenessMetadata(requested);
    const validated = parseClientAwarenessMetadata(metadata, new Uint8Array(), this.body.length);
    this.desiredAwareness = cloneAwareness(validated);
    this.scheduleAwareness();
  }

  flush(): Promise<void> {
    if (this.terminal) return Promise.reject(new Error(this.state === "closed"
      ? "collaboration_room_closed" : "collaboration_room_unavailable"));
    if (this.pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.flushWaiters.add({ resolve, reject }));
  }

  close(): void {
    this.finish("closed");
  }

  destroy(): void {
    this.close();
    this.undoManager.destroy();
    this.doc.destroy();
  }

  private readonly onDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN || this.terminal) return;
    try {
      markdownBody(this.doc, this.options.maxBodyBytes);
      if (update.byteLength > this.maxUpdateBytes) throw new Error("collaboration_update_too_large");
      const id = this.randomUUID();
      if (!isUuid(id)) throw new Error("collaboration_mutation_id_invalid");
      if (this.pending.length >= MAX_PENDING_UPDATES
          || this.pendingBytes + update.byteLength > MAX_PENDING_UPDATE_BYTES) {
        throw new Error("collaboration_pending_updates_exceeded");
      }
      this.pending.push({ id, bytes: new Uint8Array(update) });
      this.pendingBytes += update.byteLength;
      if (this.mode === "read_only") throw new Error("collaboration_read_only");
      this.publish();
      this.sendNextUpdate();
    } catch (error) {
      this.fail(error);
    }
  };

  private async connect(reconnecting: boolean): Promise<void> {
    if (this.terminal) return;
    const number = ++this.attemptNumber;
    this.setState(reconnecting ? "reconnecting" : "connecting");
    let ticket: ExperimentalTicket;
    try {
      ticket = validateTicket(await this.bridge.issueTicket({
        path: this.options.path,
        ...(this.options.mode ? { mode: this.options.mode } : {}),
        ...(this.ticketEpoch !== undefined ? { epoch: this.ticketEpoch } : {}),
        ...(this.options.signal ? { signal: this.options.signal } : {}),
        ...(this.ticketTimeoutMs !== undefined ? { timeoutMs: this.ticketTimeoutMs } : {})
      }));
      if (number !== this.attemptNumber || this.terminal) return;
      if (this.options.mode && ticket.mode !== this.options.mode) {
        throw new Error("collaboration_ticket_mode_mismatch");
      }
      if (this.ticketEpoch !== undefined && ticket.epoch !== this.ticketEpoch) {
        throw new Error("collaboration_ticket_epoch_mismatch");
      }
      this.ticketEpoch = ticket.epoch;
    } catch (error) {
      if (number !== this.attemptNumber || this.terminal) return;
      if (isRetryableTicketError(error)) this.scheduleReconnect(error);
      else this.finish("unavailable", problem(
        safeCode(error),
        "Hosted collaboration authorization is unavailable."
      ));
      return;
    }

    let socket: ExperimentalWebSocketLike;
    try {
      socket = this.webSocketFactory(ticket.webSocketUrl);
      socket.binaryType = "arraybuffer";
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }
    if (number !== this.attemptNumber || this.terminal) {
      socket.close();
      return;
    }
    const attempt: Attempt = {
      number, ticket, socket, phase: "opening",
      listeners: undefined as never
    };
    attempt.listeners = {
      open: () => this.onOpen(attempt),
      message: (event) => this.onMessage(attempt, event),
      close: (event) => this.onClose(attempt, event),
      error: () => this.onNetworkError(attempt)
    };
    for (const type of ["open", "message", "close", "error"] as const) {
      socket.addEventListener(type, attempt.listeners[type]);
    }
    this.attempt = attempt;
  }

  private onOpen(attempt: Attempt): void {
    if (!this.isCurrent(attempt) || attempt.phase !== "opening") return;
    attempt.phase = "hello";
    this.send(attempt, {
      kind: "authenticate", metadata: { ticket: attempt.ticket.ticket }, payload: new Uint8Array()
    });
  }

  private onMessage(attempt: Attempt, event: ExperimentalWebSocketEvent): void {
    if (!this.isCurrent(attempt)) return;
    try {
      const frame = decodeBinaryEvent(event);
      if (attempt.phase === "hello") {
        const hello = validateHello(frame, attempt.ticket);
        this.mode = hello.mode;
        this.epoch = hello.epoch;
        this.maxUpdateBytes = hello.maxUpdateBytes;
        if (this.pending.some((item) => item.bytes.byteLength > this.maxUpdateBytes)) {
          throw new Error("collaboration_update_too_large");
        }
        if (this.pending.length > 0 && this.mode === "read_only") {
          throw new Error("collaboration_read_only");
        }
        attempt.phase = "sync";
        this.setState("synchronizing");
        this.send(attempt, {
          kind: "sync_step_1", metadata: {}, payload: Y.encodeStateVector(this.doc)
        });
        return;
      }
      if (frame.kind === "awareness" && attempt.phase === "sync") {
        if (frame.payload.byteLength !== 0) throw new Error("awareness_payload_not_empty");
        this.deferredAwareness = frame;
        return;
      }
      if (attempt.phase === "sync") {
        if (!exactEmptyMetadata(frame, "sync_step_2")) {
          throw new Error("collaboration_sync_invalid");
        }
        if (frame.payload.byteLength > this.maxUpdateBytes) {
          throw new Error("collaboration_update_too_large");
        }
        Y.applyUpdate(this.doc, frame.payload, REMOTE_ORIGIN);
        markdownBody(this.doc, this.options.maxBodyBytes);
        attempt.phase = "connected";
        this.reconnectCount = 0;
        this.updateInFlight = false;
        this.heartbeatPending = false;
        this.lastAwarenessSent = Number.NEGATIVE_INFINITY;
        this.setState("connected");
        if (this.deferredAwareness) {
          const deferred = this.deferredAwareness;
          this.deferredAwareness = undefined;
          this.applyAwarenessFrame(deferred);
        }
        this.startHeartbeat();
        this.sendNextUpdate();
        this.scheduleAwareness();
        return;
      }
      if (attempt.phase !== "connected") throw new Error("collaboration_frame_unexpected");
      this.onConnectedFrame(attempt, frame);
    } catch (error) {
      this.fail(error);
    }
  }

  private onConnectedFrame(attempt: Attempt, frame: CollaborationFrame): void {
    if (frame.kind === "acknowledged") {
      const ack = exactAcknowledgement(frame);
      if (this.acknowledged.has(ack.clientMutationId)) return;
      const expected = this.pending[0];
      if (!expected || expected.id !== ack.clientMutationId || !this.updateInFlight) {
        throw new Error("collaboration_ack_mismatch");
      }
      this.pending.shift();
      this.pendingBytes -= expected.bytes.byteLength;
      this.rememberAcknowledged(ack.clientMutationId);
      this.updateInFlight = false;
      this.publish();
      if (this.pending.length === 0) this.resolveFlushes();
      this.sendNextUpdate();
      return;
    }
    if (frame.kind === "update") {
      if (!exactUpdateMetadata(frame, this.epoch!) || frame.payload.byteLength > this.maxUpdateBytes) {
        throw new Error("collaboration_update_invalid");
      }
      Y.applyUpdate(this.doc, frame.payload, REMOTE_ORIGIN);
      markdownBody(this.doc, this.options.maxBodyBytes);
      this.publish();
      return;
    }
    if (frame.kind === "awareness") {
      this.applyAwarenessFrame(frame);
      return;
    }
    if (frame.kind === "heartbeat") {
      if (!this.heartbeatPending || !exactEmptyFrame(frame, "heartbeat")) {
        throw new Error("collaboration_heartbeat_invalid");
      }
      this.heartbeatPending = false;
      return;
    }
    throw new Error("collaboration_frame_unexpected");
  }

  private applyAwarenessFrame(frame: CollaborationFrame): void {
    if (frame.kind !== "awareness" || frame.payload.byteLength !== 0) {
      throw new Error("collaboration_awareness_invalid");
    }
    const parsed = parseAwarenessSnapshotMetadata(
      frame.metadata,
      Math.min(this.options.maxBodyBytes, 0xFFFFFFFF)
    );
    this.participants = parsed.participants.map((participant) => ({
      ...participant,
      selections: participant.selections.map((selection) => ({ ...selection }))
    }));
    this.publish();
  }

  private sendNextUpdate(): void {
    const attempt = this.attempt;
    const update = this.pending[0];
    if (!attempt || attempt.phase !== "connected" || !update || this.updateInFlight) return;
    if (this.mode !== "read_write" || update.bytes.byteLength > this.maxUpdateBytes) {
      this.fail(new Error("collaboration_update_invalid"));
      return;
    }
    this.updateInFlight = true;
    this.send(attempt, {
      kind: "update",
      metadata: {
        client_mutation_id: update.id,
        profile: "markdown-body-yjs-v13",
        epoch: this.epoch
      },
      payload: update.bytes
    });
  }

  private scheduleAwareness(): void {
    if (!this.desiredAwareness || this.terminal || this.awarenessTimer) return;
    const attempt = this.attempt;
    if (!attempt || attempt.phase !== "connected") return;
    const wait = Math.max(0, this.lastAwarenessSent + this.awarenessThrottleMs - Date.now());
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = undefined;
      const current = this.attempt;
      if (!this.desiredAwareness || !current || current.phase !== "connected" || this.terminal) return;
      try {
        const metadata = encodeClientAwarenessMetadata(this.desiredAwareness);
        parseClientAwarenessMetadata(metadata, new Uint8Array(), this.body.length);
        this.send(current, { kind: "awareness", metadata, payload: new Uint8Array() });
        this.lastAwarenessSent = Date.now();
      } catch (error) {
        this.fail(error);
      }
    }, wait);
  }

  private startHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const attempt = this.attempt;
      if (!attempt || attempt.phase !== "connected" || this.terminal) return;
      if (this.heartbeatPending) {
        this.onNetworkError(attempt);
        return;
      }
      this.heartbeatPending = true;
      this.send(attempt, { kind: "heartbeat", metadata: {}, payload: new Uint8Array() });
    }, this.heartbeatMs);
  }

  private send(attempt: Attempt, frame: CollaborationFrame): void {
    if (!this.isCurrent(attempt) || attempt.socket.readyState !== 1) return;
    let encoded: Uint8Array;
    try {
      encoded = encodeCollaborationFrame(frame);
    } catch (error) {
      this.fail(error);
      return;
    }
    try {
      attempt.socket.send(encoded);
    } catch {
      this.onNetworkError(attempt);
    }
  }

  private onClose(attempt: Attempt, event: ExperimentalWebSocketEvent): void {
    if (!this.isCurrent(attempt)) return;
    const code = event.code ?? 1006;
    this.detachAttempt(attempt, false);
    if (code === 1008) {
      this.finish("unavailable", problem("collaboration_policy_ended", "Hosted collaboration is unavailable."));
    } else if (code === 1001 || code === 1011 || code === 1006 || code === 0) {
      this.scheduleReconnect();
    } else {
      this.finish("unavailable", problem("collaboration_connection_closed", "Hosted collaboration is unavailable."));
    }
  }

  private onNetworkError(attempt: Attempt): void {
    if (!this.isCurrent(attempt)) return;
    this.detachAttempt(attempt, true);
    this.scheduleReconnect();
  }

  private scheduleReconnect(_cause?: unknown): void {
    if (this.terminal || this.reconnectTimer) return;
    this.setState("reconnecting");
    const exponent = Math.min(this.reconnectCount++, 8);
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** exponent));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(true);
    }, delay);
  }

  private fail(error: unknown): void {
    const code = safeCode(error);
    this.finish("unavailable", problem(code, "Hosted collaboration protocol failed."));
  }

  private finish(
    state: "closed" | "unavailable",
    failure?: ExperimentalHostedRoomProblem,
    closeSocket = true
  ): void {
    if (this.terminal) return;
    this.terminal = true;
    this.attemptNumber += 1;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.awarenessTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.awarenessTimer = undefined;
    this.heartbeatTimer = undefined;
    if (this.attempt) this.detachAttempt(this.attempt, closeSocket);
    this.options.signal?.removeEventListener("abort", this.abortListener);
    this.doc.off("update", this.onDocumentUpdate);
    this.state = state;
    this.publish(failure);
    this.rejectFlushes(new Error(state === "closed"
      ? "collaboration_room_closed" : "collaboration_room_unavailable"));
  }

  private detachAttempt(attempt: Attempt, closeSocket: boolean): void {
    if (this.attempt === attempt) this.attempt = undefined;
    for (const type of ["open", "message", "close", "error"] as const) {
      attempt.socket.removeEventListener(type, attempt.listeners[type]);
    }
    clearTimeout(this.awarenessTimer);
    clearInterval(this.heartbeatTimer);
    this.awarenessTimer = undefined;
    this.heartbeatTimer = undefined;
    this.heartbeatPending = false;
    this.updateInFlight = false;
    this.deferredAwareness = undefined;
    if (closeSocket) {
      try { attempt.socket.close(SAFE_CLOSE_CODE, "protocol ended"); } catch { /* best effort */ }
    }
  }

  private isCurrent(attempt: Attempt): boolean {
    return !this.terminal && this.attempt === attempt && attempt.number === this.attemptNumber;
  }

  private setState(state: ExperimentalHostedRoomState): void {
    this.state = state;
    this.publish();
  }

  private publish(failure?: ExperimentalHostedRoomProblem): void {
    this.currentSnapshot = this.makeSnapshot(failure);
    for (const listener of [...this.listeners]) {
      try { listener(this.currentSnapshot); } catch { /* listeners cannot alter protocol state */ }
    }
  }

  private makeSnapshot(failure?: ExperimentalHostedRoomProblem): ExperimentalHostedMarkdownRoomSnapshot {
    let body = "";
    try { body = markdownBody(this.doc, this.options.maxBodyBytes); } catch { body = this.body.toString(); }
    const participants = this.participants.map((participant) => Object.freeze({
      ...participant,
      selections: Object.freeze(participant.selections.map((selection) => Object.freeze({ ...selection })))
    }));
    return Object.freeze({
      state: this.state,
      body,
      ...(this.mode ? { mode: this.mode } : {}),
      ...(this.epoch !== undefined ? { epoch: this.epoch } : {}),
      pendingUpdates: this.pending.length,
      participants: Object.freeze(participants),
      ...(failure ? { problem: Object.freeze({ ...failure }) } : {})
    });
  }

  private rememberAcknowledged(id: string): void {
    this.acknowledged.add(id);
    this.acknowledgedOrder.push(id);
    if (this.acknowledgedOrder.length > MAX_ACKNOWLEDGED_IDS) {
      this.acknowledged.delete(this.acknowledgedOrder.shift()!);
    }
  }

  private resolveFlushes(): void {
    for (const waiter of this.flushWaiters) waiter.resolve();
    this.flushWaiters.clear();
  }

  private rejectFlushes(error: Error): void {
    for (const waiter of this.flushWaiters) waiter.reject(error);
    this.flushWaiters.clear();
  }
}

function exactEmptyMetadata(frame: CollaborationFrame, kind: CollaborationFrame["kind"]): boolean {
  return frame.kind === kind && Object.keys(frame.metadata).length === 0;
}

function cloneAwareness(update: ClientAwarenessUpdate): ClientAwarenessUpdate {
  return { status: update.status, selections: update.selections.map((selection) => ({ ...selection })) };
}

function nativeWebSocketFactory(url: string): ExperimentalWebSocketLike {
  return new WebSocket(url) as unknown as ExperimentalWebSocketLike;
}

function positiveTiming(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)) return error.message;
  return "collaboration_protocol_invalid";
}

function isRetryableTicketError(error: unknown): boolean {
  return Boolean(error && typeof error === "object"
    && (error as { retryable?: unknown }).retryable === true);
}

function problem(code: string, message: string): ExperimentalHostedRoomProblem {
  return Object.freeze({ code: code.slice(0, 80), message: message.slice(0, 160) });
}
