import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  decodeCollaborationFrame,
  encodeAwarenessSnapshotMetadata,
  encodeCollaborationFrame,
  type CollaborationFrame
} from "@mdbase-dev/connect-protocol";
import {
  EXPERIMENTAL_HOSTED_COLLABORATION_SYMBOL,
  type ExperimentalTicket
} from "./experimental-wire.js";
import {
  openExperimentalHostedMarkdownRoom,
  type ExperimentalHostedMarkdownRoom,
  type ExperimentalWebSocketEvent,
  type ExperimentalWebSocketLike
} from "./index.js";

const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002"
];

class FakeSocket implements ExperimentalWebSocketLike {
  binaryType = "blob";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
  private readonly listeners = new Map<string, Set<(event: ExperimentalWebSocketEvent) => void>>();

  send(data: ArrayBuffer | ArrayBufferView): void {
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(new Uint8Array(bytes));
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push([code, reason]);
  }

  addEventListener(type: string, listener: (event: ExperimentalWebSocketEvent) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) this.listeners.set(type, listeners = new Set());
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: ExperimentalWebSocketEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  server(frame: CollaborationFrame): void {
    this.emit("message", { data: encodeCollaborationFrame(frame) });
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.emit("close", { code });
  }

  error(): void {
    this.emit("error", {});
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, entries) => sum + entries.size, 0);
  }

  frames(): CollaborationFrame[] {
    return this.sent.map((bytes) => decodeCollaborationFrame(bytes));
  }

  private emit(type: string, event: ExperimentalWebSocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

interface Fixture {
  room: ExperimentalHostedMarkdownRoom;
  sockets: FakeSocket[];
  issueTicket: ReturnType<typeof vi.fn>;
}

function fixture(overrides: {
  maxBodyBytes?: number;
  heartbeatMs?: number;
  reconnectMs?: number;
  handshakeMs?: number;
  mode?: "read_only" | "read_write";
  ticketError?: unknown;
} = {}): Fixture {
  const sockets: FakeSocket[] = [];
  const mode = overrides.mode ?? "read_write";
  let ticketNumber = 0;
  const issueTicket = vi.fn(async (): Promise<ExperimentalTicket> => {
    if (overrides.ticketError) throw overrides.ticketError;
    return {
      ticket: `ticket-${++ticketNumber}`,
      webSocketUrl: "wss://provider.example/v1/collaboration",
      expiresAt: "2099-01-01T00:00:00.000Z",
      profile: "markdown-body-yjs-v13",
      mode,
      epoch: 7
    };
  });
  const connection = {};
  Object.defineProperty(connection, EXPERIMENTAL_HOSTED_COLLABORATION_SYMBOL, {
    value: Object.freeze({ issueTicket }), enumerable: false, configurable: false, writable: false
  });
  let id = 0;
  const room = openExperimentalHostedMarkdownRoom(connection, {
    path: "note.md",
    maxBodyBytes: overrides.maxBodyBytes ?? 1024,
    mode,
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    timing: {
      heartbeatMs: overrides.heartbeatMs ?? 15_000,
      handshakeTimeoutMs: overrides.handshakeMs ?? 15_000,
      reconnectBaseMs: overrides.reconnectMs ?? 10,
      reconnectMaxMs: overrides.reconnectMs ?? 10
    },
    randomUUID: () => IDS[id++]!,
    random: () => 0.5
  });
  return { room, sockets, issueTicket };
}

function hello(overrides: Record<string, unknown> = {}): CollaborationFrame {
  return {
    kind: "hello",
    metadata: {
      profile: "markdown-body-yjs-v13",
      mode: "read_write",
      epoch: 7,
      limits: { max_update_bytes: 262_144 },
      awareness: {
        version: 1,
        scope: "provider_instance",
        max_participants: 16,
        max_selections: 4,
        max_updates_per_second: 8,
        ttl_seconds: 30
      },
      ...overrides
    },
    payload: new Uint8Array()
  };
}

function updateFor(body: string, extraRoot = false): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, body);
  if (extraRoot) doc.getMap("metadata").set("hidden", true);
  return Y.encodeStateAsUpdate(doc);
}

async function socketAt(f: Fixture, index: number): Promise<FakeSocket> {
  await vi.waitFor(() => expect(f.sockets.length).toBeGreaterThan(index));
  return f.sockets[index]!;
}

async function synchronize(f: Fixture, index = 0, body = "seed"): Promise<FakeSocket> {
  const socket = await socketAt(f, index);
  socket.open();
  socket.server(hello());
  socket.server({ kind: "sync_step_2", metadata: {}, payload: updateFor(body) });
  expect(f.room.snapshot.state).toBe("connected");
  return socket;
}

function awareness(name: string, anchor = 0): CollaborationFrame {
  return {
    kind: "awareness",
    metadata: encodeAwarenessSnapshotMetadata({
      participants: [{
        name, color: "teal", status: "active",
        selections: [{ anchor, head: anchor }]
      }]
    }),
    payload: new Uint8Array()
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("experimental hosted Markdown provider", () => {
  it("orders Authenticate, Hello, SyncStep1 and tolerates interleaved awareness", async () => {
    const f = fixture();
    const socket = await socketAt(f, 0);
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    expect(socket.frames()).toMatchObject([
      { kind: "authenticate", metadata: { ticket: "ticket-1" }, payload: new Uint8Array() }
    ]);

    socket.server(hello());
    expect(socket.frames()[1]).toMatchObject({ kind: "sync_step_1", metadata: {} });
    socket.server(awareness("Ada", 4));
    socket.server({ kind: "sync_step_2", metadata: {}, payload: updateFor("seed") });

    expect(f.room.snapshot).toMatchObject({
      state: "connected", body: "seed", mode: "read_write", epoch: 7,
      participants: [{ name: "Ada" }]
    });
    f.room.destroy();
  });

  it("queues one local update, resolves flush on exact ack, and replaces awareness", async () => {
    const f = fixture();
    const socket = await synchronize(f);
    socket.server(awareness("Ada"));
    socket.server(awareness("Grace"));
    expect(f.room.snapshot.participants.map((entry) => entry.name)).toEqual(["Grace"]);

    f.room.body.insert(f.room.body.length, "!");
    const sent = socket.frames().at(-1)!;
    expect(sent).toMatchObject({
      kind: "update",
      metadata: {
        client_mutation_id: IDS[0], profile: "markdown-body-yjs-v13", epoch: 7
      }
    });
    expect(f.room.snapshot.pendingUpdates).toBe(1);
    const flushed = f.room.flush();
    expect(f.room.flush()).toBe(flushed);
    socket.server({
      kind: "acknowledged",
      metadata: { client_mutation_id: IDS[0], sequence: 1, record_sequence: 1 },
      payload: new Uint8Array()
    });
    await expect(flushed).resolves.toBeUndefined();
    expect(f.room.snapshot.pendingUpdates).toBe(0);
    expect(Object.isFrozen(f.room.snapshot.participants)).toBe(true);
    f.room.destroy();
  });

  it("gets a fresh ticket and replays the same mutation id only after reconnect sync", async () => {
    vi.useFakeTimers();
    const f = fixture({ reconnectMs: 10 });
    const first = await synchronize(f);
    f.room.body.insert(4, "!");
    const firstUpdate = first.frames().at(-1)!;
    first.serverClose(1001);
    expect(f.room.snapshot.state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(10);
    const second = await socketAt(f, 1);
    expect(f.issueTicket).toHaveBeenCalledTimes(2);
    expect(f.issueTicket.mock.calls[0]?.[0]).not.toHaveProperty("epoch");
    expect(f.issueTicket.mock.calls[1]?.[0]).toMatchObject({ epoch: 7 });
    second.open();
    second.server(hello());
    expect(second.frames().map((frame) => frame.kind)).toEqual(["authenticate", "sync_step_1"]);
    second.server({ kind: "sync_step_2", metadata: {}, payload: updateFor("seed!") });
    const replay = second.frames().at(-1)!;
    expect(replay.kind).toBe("update");
    expect(replay.metadata.client_mutation_id).toBe(firstUpdate.metadata.client_mutation_id);
    f.room.destroy();
  });

  it("does not ticket-loop on terminal ticket authorization failure", async () => {
    vi.useFakeTimers();
    const f = fixture({
      ticketError: { code: "authority_authorization_changed", retryable: false }
    });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.room.snapshot.state).toBe("unavailable");
    expect(f.room.snapshot.problem?.code).toBe("authority_authorization_changed");
    expect(f.issueTicket).toHaveBeenCalledTimes(1);
  });

  it("bounds silent pre-Hello authentication retries", async () => {
    vi.useFakeTimers();
    const f = fixture({ reconnectMs: 10 });
    for (let index = 0; index < 4; index += 1) {
      const socket = await socketAt(f, index);
      socket.open();
      socket.serverClose(1006);
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.room.snapshot.state).toBe("unavailable");
    expect(f.room.snapshot.problem?.code).toBe("collaboration_handshake_failed");
    expect(f.issueTicket).toHaveBeenCalledTimes(4);
  });

  it("reconnects when opening or synchronization stalls", async () => {
    vi.useFakeTimers();
    const f = fixture({ reconnectMs: 10, handshakeMs: 20 });
    await vi.runAllTicks();
    expect(f.sockets).toHaveLength(1);
    const first = f.sockets[0]!;
    first.open();
    await vi.advanceTimersByTimeAsync(20);
    expect(first.closeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTicks();
    expect(f.sockets).toHaveLength(2);
    expect(f.issueTicket).toHaveBeenCalledTimes(2);
    f.room.destroy();
  });

  it("does not ticket-loop after 1008 but reconnects after abnormal closure", async () => {
    vi.useFakeTimers();
    const terminal = fixture({ reconnectMs: 10 });
    (await synchronize(terminal)).serverClose(1008);
    await vi.advanceTimersByTimeAsync(100);
    expect(terminal.room.snapshot.state).toBe("unavailable");
    expect(terminal.issueTicket).toHaveBeenCalledTimes(1);

    const retry = fixture({ reconnectMs: 10 });
    const retrySocket = await synchronize(retry);
    retrySocket.server(awareness("Participant 1"));
    retrySocket.serverClose(1006);
    expect(retry.room.snapshot.participants).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    await socketAt(retry, 1);
    expect(retry.issueTicket).toHaveBeenCalledTimes(2);
    terminal.room.destroy();
    retry.room.destroy();
  });

  it.each([
    ["text frame", (socket: FakeSocket) => socket.message("not binary")],
    ["wrong epoch", (socket: FakeSocket) => socket.server({
      kind: "update", metadata: { profile: "markdown-body-yjs-v13", epoch: 8 },
      payload: updateFor("remote")
    })],
    ["malformed metadata", (socket: FakeSocket) => socket.server({
      kind: "heartbeat", metadata: { extra: true }, payload: new Uint8Array()
    })]
  ])("fails closed for %s", async (_name, attack) => {
    const f = fixture();
    const socket = await synchronize(f);
    attack(socket);
    expect(f.room.snapshot.state).toBe("unavailable");
    expect(f.room.snapshot.problem?.message).not.toContain("seed");
    expect(socket.closeCalls.at(-1)?.[0]).toBe(1008);
  });

  it("refreshes unchanged awareness before the advertised TTL", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const socket = await socketAt(f, 0);
    socket.open();
    socket.server(hello({
      awareness: {
        version: 1,
        scope: "provider_instance",
        max_participants: 16,
        max_selections: 4,
        max_updates_per_second: 8,
        ttl_seconds: 1
      }
    }));
    socket.server({ kind: "sync_step_2", metadata: {}, payload: updateFor("seed") });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.frames().filter((frame) => frame.kind === "awareness")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.frames().filter((frame) => frame.kind === "awareness")).toHaveLength(2);
    f.room.destroy();
  });

  it("fails closed without queueing local mutations in a read-only room", async () => {
    const f = fixture({ mode: "read_only" });
    const socket = await socketAt(f, 0);
    socket.open();
    socket.server(hello({ mode: "read_only" }));
    socket.server({ kind: "sync_step_2", metadata: {}, payload: updateFor("seed") });
    f.room.body.insert(0, "x");
    expect(f.room.snapshot.state).toBe("unavailable");
    expect(f.room.snapshot.pendingUpdates).toBe(0);
  });

  it("accepts committed awareness positions beyond a shorter unacknowledged local body", async () => {
    const f = fixture();
    const socket = await synchronize(f, 0, "seed");
    f.room.body.delete(0, 4);
    socket.server(awareness("Participant 1", 4));
    expect(f.room.snapshot.state).toBe("connected");
    expect(f.room.snapshot.participants[0]?.selections[0]?.anchor).toBe(4);
    f.room.destroy();
  });

  it("sends and strictly accepts heartbeat frames", async () => {
    vi.useFakeTimers();
    const f = fixture({ heartbeatMs: 100 });
    const socket = await synchronize(f);
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.frames().at(-1)).toMatchObject({
      kind: "heartbeat", metadata: {}, payload: new Uint8Array()
    });
    socket.server({ kind: "heartbeat", metadata: {}, payload: new Uint8Array() });
    expect(f.room.snapshot.state).toBe("connected");
    f.room.destroy();
  });

  it("coalesces semantic awareness and cleans up every listener and timer on destroy", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const socket = await synchronize(f);
    f.room.setAwareness({ status: "active", selections: [{ anchor: 1, head: 2 }] });
    f.room.setAwareness({ status: "idle", selections: [] });
    await vi.advanceTimersByTimeAsync(0);
    const frames = socket.frames().filter((frame) => frame.kind === "awareness");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.metadata).toEqual({ status: "idle", selections: [] });
    f.room.destroy();
    expect(f.room.snapshot.state).toBe("closed");
    expect(socket.listenerCount()).toBe(0);
    expect(socket.closeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.issueTicket).toHaveBeenCalledTimes(1);
  });

  it("fails closed on body, root, and negotiated update bounds and rejects flush", async () => {
    const bodyBound = fixture({ maxBodyBytes: 3 });
    const bodySocket = await socketAt(bodyBound, 0);
    bodySocket.open();
    bodySocket.server(hello());
    bodySocket.server({ kind: "sync_step_2", metadata: {}, payload: updateFor("four") });
    expect(bodyBound.room.snapshot.state).toBe("unavailable");

    const rootBound = fixture();
    const rootSocket = await socketAt(rootBound, 0);
    rootSocket.open();
    rootSocket.server(hello());
    rootSocket.server({ kind: "sync_step_2", metadata: {}, payload: updateFor("safe", true) });
    expect(rootBound.room.snapshot.state).toBe("unavailable");

    const aggregateSync = fixture();
    const aggregateSocket = await socketAt(aggregateSync, 0);
    aggregateSocket.open();
    aggregateSocket.server(hello({ limits: { max_update_bytes: 2 } }));
    aggregateSocket.server({
      kind: "sync_step_2", metadata: {}, payload: updateFor("aggregate state")
    });
    expect(aggregateSync.room.snapshot.state).toBe("connected");

    const updateBound = fixture();
    const updateSocket = await socketAt(updateBound, 0);
    updateSocket.open();
    updateSocket.server(hello({ limits: { max_update_bytes: 2 } }));
    updateSocket.server({ kind: "sync_step_2", metadata: {}, payload: new Uint8Array([0, 0]) });
    expect(updateBound.room.snapshot.state).toBe("connected");
    updateBound.room.body.insert(0, "x");
    expect(updateBound.room.snapshot.state).toBe("unavailable");
    await expect(updateBound.room.flush()).rejects.toThrow();
  });

  it("rejects a pending flush when a terminal policy close arrives", async () => {
    const f = fixture();
    const socket = await synchronize(f);
    f.room.body.insert(0, "x");
    const flush = f.room.flush();
    socket.serverClose(1008);
    await expect(flush).rejects.toThrow("unavailable");
  });
});
