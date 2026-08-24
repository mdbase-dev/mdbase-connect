import type * as Y from "yjs";

export type ExperimentalCollaborationMode = "read_only" | "read_write";
export type ExperimentalHostedRoomState =
  | "connecting"
  | "synchronizing"
  | "connected"
  | "reconnecting"
  | "unavailable"
  | "closed";
export type ExperimentalAwarenessStatus = "active" | "idle";
export type ExperimentalAwarenessColor =
  | "blue" | "teal" | "green" | "amber" | "orange" | "rose" | "violet" | "slate";

export interface ExperimentalAwarenessSelection {
  readonly anchor: number;
  readonly head: number;
}

export interface ExperimentalHostedAwarenessState {
  readonly status: ExperimentalAwarenessStatus;
  readonly selections: readonly ExperimentalAwarenessSelection[];
}

export interface ExperimentalHostedRoomProblem {
  readonly code: string;
  readonly message: string;
}

export interface ExperimentalHostedRoomParticipant {
  readonly name: string;
  readonly color: ExperimentalAwarenessColor;
  readonly status: ExperimentalAwarenessStatus;
  readonly selections: readonly ExperimentalAwarenessSelection[];
}

export interface ExperimentalHostedMarkdownRoomSnapshot {
  readonly state: ExperimentalHostedRoomState;
  readonly body: string;
  readonly mode?: ExperimentalCollaborationMode;
  readonly epoch?: number;
  readonly pendingUpdates: number;
  readonly participants: readonly ExperimentalHostedRoomParticipant[];
  readonly problem?: ExperimentalHostedRoomProblem;
}

export type ExperimentalHostedMarkdownRoomListener = (
  snapshot: ExperimentalHostedMarkdownRoomSnapshot
) => void;

export interface ExperimentalHostedMarkdownRoom {
  readonly doc: Y.Doc;
  readonly body: Y.Text;
  readonly undoManager: Y.UndoManager;
  readonly snapshot: ExperimentalHostedMarkdownRoomSnapshot;
  subscribe(listener: ExperimentalHostedMarkdownRoomListener): () => void;
  setAwareness(update: ExperimentalHostedAwarenessState): void;
  flush(): Promise<void>;
  close(): void;
  destroy(): void;
}

export interface ExperimentalWebSocketEvent {
  readonly data?: unknown;
  readonly code?: number;
}

export interface ExperimentalWebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: ExperimentalWebSocketEvent) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: ExperimentalWebSocketEvent) => void): void;
}

export type ExperimentalWebSocketFactory = (url: string) => ExperimentalWebSocketLike;

export interface ExperimentalHostedMarkdownRoomOptions {
  path: string;
  maxBodyBytes: number;
  mode?: ExperimentalCollaborationMode;
  signal?: AbortSignal;
  webSocketFactory?: ExperimentalWebSocketFactory;
  /** @internal Deterministic test overrides; production callers should omit. */
  timing?: Partial<{
    heartbeatMs: number;
    handshakeTimeoutMs: number;
    reconnectBaseMs: number;
    reconnectMaxMs: number;
    awarenessThrottleMs: number;
    ticketTimeoutMs: number;
  }>;
  /** @internal Deterministic test overrides; production callers should omit. */
  randomUUID?: () => string;
  random?: () => number;
}
