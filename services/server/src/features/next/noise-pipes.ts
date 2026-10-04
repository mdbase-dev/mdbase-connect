// Noise pipes between thin clients and daemons through the relay (interface note
// 2026-10-04-control-daemon-grant-feed-and-relay.md §4).
//
// The relay is a dumb pipe: it admits a client by its app access token, pairs it with
// the daemon's bound relay socket, and forwards opaque bytes in both directions. The
// daemon authorizes the session itself (Noise IK against its access list). The two
// sockets may live on different instances, so every hop goes through the relay
// broker: `open.<connector>.<generation>` to the instance holding the daemon's socket,
// then `<pipe>.device` and `<pipe>.client` for the two directions.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { DatabasePool } from "../../database-types.js";
import { pipeSubject, type RelayBroker, type RelayBrokerBinding } from "../../relay-broker.js";
import { currentRelayGeneration } from "../../relay-compatibility.js";
import { tokenHash } from "../../security.js";

export const NOISE_PIPE_CAPABILITY = "noise_pipe_v1";
const PIPE_FRAME_MAGIC = Buffer.from("MDBN");
/** `u32be(len) ‖ Noise message`, at most 65,535 bytes of message (replica-client-api §12.3). */
const MAX_PIPE_PAYLOAD = 65_539;

export interface NoisePipeLimits {
  perGrant: number;
  perConnector: number;
  authTimeoutMs: number;
  openTimeoutMs: number;
  handshakeMs: number;
  idleMs: number;
  lifetimeMs: number;
}

export const DEFAULT_NOISE_PIPE_LIMITS: NoisePipeLimits = {
  perGrant: 8,
  perConnector: 64,
  authTimeoutMs: 10_000,
  openTimeoutMs: 5_000,
  handshakeMs: 30_000,
  idleMs: 10 * 60_000,
  lifetimeMs: 24 * 60 * 60_000,
};

// Broker frames: one type byte, then the payload.
const DATA = 0;
const OPENED = 1;
const CLOSE = 2;
const frame = (type: number, payload: Uint8Array = new Uint8Array()) => Buffer.concat([Buffer.of(type), payload]);
const closeFrame = (reason: string) => frame(CLOSE, Buffer.from(reason, "utf8"));

interface DevicePipe {
  grantId: string;
  socket: WebSocket;
  inbound: RelayBrokerBinding;
  openedAt: number;
  lastActivity: number;
  handshaken: boolean;
}

interface DeviceSocket {
  connectorId: string;
  generation: string;
  deviceId: string;
  open: RelayBrokerBinding;
  pipes: Map<string, DevicePipe>;
}

/** Daemon side: pipes owned by the instance that holds the daemon's bound socket. */
export class NoisePipes {
  private readonly sockets = new Map<WebSocket, DeviceSocket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly db: DatabasePool,
    private readonly broker: RelayBroker,
    private readonly limits: NoisePipeLimits = DEFAULT_NOISE_PIPE_LIMITS,
    private readonly now: () => number = Date.now
  ) {
    this.sweeper = setInterval(() => this.sweep(), 5_000);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const socket of [...this.sockets.keys()]) void this.detach(socket, "relay_closing");
  }

  /**
   * Start accepting pipes for a socket whose device bind has succeeded. Only bound
   * sockets are ever attached, so nothing is routed while a bind is pending.
   */
  async attach(socket: WebSocket, connectorId: string, generation: string, deviceId: string): Promise<void> {
    if (this.sockets.has(socket)) return;
    const open = await this.broker.subscribePipe(pipeSubject("open", connectorId, generation), (data) => {
      void this.open(socket, data).catch(() => undefined);
    });
    this.sockets.set(socket, { connectorId, generation, deviceId, open, pipes: new Map() });
    socket.once("close", () => void this.detach(socket, "connector_offline"));
  }

  private async open(socket: WebSocket, data: Uint8Array): Promise<void> {
    const state = this.sockets.get(socket);
    let request: { pipe_id?: unknown; collection_id?: unknown; grant_id?: unknown; device_id?: unknown; device_noise_pk?: unknown };
    try {
      request = JSON.parse(Buffer.from(data).toString("utf8")) as typeof request;
    } catch {
      return;
    }
    const { pipe_id: pipeId, collection_id: collectionId, grant_id: grantId } = request;
    if (typeof pipeId !== "string" || typeof grantId !== "string" || typeof collectionId !== "string" || !/^[0-9a-f-]{36}$/.test(pipeId)) return;
    const toClient = pipeSubject(pipeId, "client");
    if (!state || socket.readyState !== 1) return this.broker.publishPipe(toClient, closeFrame("connector_offline"));
    // SEC-039: the client names the device and the Noise key it will handshake with.
    // Route only to this bound socket of that device, only while its relay generation
    // is still current (a failed fence can leave an old socket open), and only when
    // the key matches the device's registration.
    if (request.device_id !== state.deviceId) return this.broker.publishPipe(toClient, closeFrame("device_mismatch"));
    const current = await this.db.query<{ relay_generation: string | number; noise_pk: Buffer }>(
      `SELECT c.relay_generation, d.noise_pk FROM connectors c
       JOIN next_devices d ON d.connector_id = c.id
       JOIN users u ON u.id = c.user_id
       WHERE c.id = $1 AND d.id = $2 AND c.revoked_at IS NULL AND u.suspended_at IS NULL`,
      [state.connectorId, state.deviceId]
    );
    const row = current.rows[0];
    if (!row || String(row.relay_generation) !== state.generation) {
      await this.detach(socket, "connector_offline");
      return this.broker.publishPipe(toClient, closeFrame("connector_offline"));
    }
    if (typeof request.device_noise_pk !== "string" || row.noise_pk.toString("hex") !== request.device_noise_pk) {
      return this.broker.publishPipe(toClient, closeFrame("device_key_mismatch"));
    }
    const sameGrant = [...state.pipes.values()].filter((pipe) => pipe.grantId === grantId).length;
    if (state.pipes.size >= this.limits.perConnector || sameGrant >= this.limits.perGrant) {
      return this.broker.publishPipe(toClient, closeFrame("connector_busy"));
    }
    const inbound = await this.broker.subscribePipe(pipeSubject(pipeId, "device"), (message) => this.fromClient(socket, pipeId, message));
    const at = this.now();
    state.pipes.set(pipeId, { grantId, socket, inbound, openedAt: at, lastActivity: at, handshaken: false });
    socket.send(JSON.stringify({ type: "pipe_open", pipe_id: pipeId, collection_id: collectionId, grant_id: grantId }));
    await this.broker.publishPipe(toClient, frame(OPENED));
  }

  private fromClient(socket: WebSocket, pipeId: string, message: Uint8Array): void {
    const pipe = this.sockets.get(socket)?.pipes.get(pipeId);
    if (!pipe || message.length === 0) return;
    if (message[0] === CLOSE) {
      void this.closePipe(socket, pipeId, Buffer.from(message.subarray(1)).toString("utf8") || "client_closed", false);
      return;
    }
    if (message[0] !== DATA || socket.readyState !== 1) return;
    pipe.lastActivity = this.now();
    socket.send(Buffer.concat([PIPE_FRAME_MAGIC, uuidBuffer(pipeId), message.subarray(1)]));
  }

  /** A binary frame from the daemon. Returns false when it is not a pipe frame. */
  handleDeviceBinary(socket: WebSocket, raw: Buffer): boolean {
    if (!Buffer.isBuffer(raw) || raw.length < 20 || !raw.subarray(0, 4).equals(PIPE_FRAME_MAGIC)) return false;
    const pipeId = uuidString(raw.subarray(4, 20));
    const pipe = this.sockets.get(socket)?.pipes.get(pipeId);
    const payload = raw.subarray(20);
    if (!pipe) return true;
    if (payload.length > MAX_PIPE_PAYLOAD) {
      void this.closePipe(socket, pipeId, "frame_too_large", true);
      return true;
    }
    pipe.lastActivity = this.now();
    pipe.handshaken = true;
    void this.broker.publishPipe(pipeSubject(pipeId, "client"), frame(DATA, payload)).catch(() => undefined);
    return true;
  }

  /** `pipe_close` from the daemon. */
  handleDeviceClose(socket: WebSocket, message: Record<string, unknown>): void {
    if (typeof message.pipe_id !== "string") return;
    const reason = typeof message.reason === "string" ? message.reason.slice(0, 64) : "closed";
    void this.closePipe(socket, message.pipe_id, reason, false, true);
  }

  private async closePipe(socket: WebSocket, pipeId: string, reason: string, tellDevice: boolean, tellClient = true): Promise<void> {
    const state = this.sockets.get(socket);
    const pipe = state?.pipes.get(pipeId);
    if (!state || !pipe) return;
    state.pipes.delete(pipeId);
    await pipe.inbound.close();
    if (tellDevice && socket.readyState === 1) socket.send(JSON.stringify({ type: "pipe_close", pipe_id: pipeId, reason }));
    if (tellClient) await this.broker.publishPipe(pipeSubject(pipeId, "client"), closeFrame(reason)).catch(() => undefined);
  }

  private async detach(socket: WebSocket, reason: string): Promise<void> {
    const state = this.sockets.get(socket);
    if (!state) return;
    this.sockets.delete(socket);
    await state.open.close();
    for (const pipeId of [...state.pipes.keys()]) {
      const pipe = state.pipes.get(pipeId)!;
      await pipe.inbound.close();
      await this.broker.publishPipe(pipeSubject(pipeId, "client"), closeFrame(reason)).catch(() => undefined);
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [socket, state] of this.sockets) {
      for (const [pipeId, pipe] of state.pipes) {
        const reason = !pipe.handshaken && now - pipe.openedAt > this.limits.handshakeMs ? "handshake_timeout"
          : now - pipe.lastActivity > this.limits.idleMs ? "idle"
            : now - pipe.openedAt > this.limits.lifetimeMs ? "lifetime" : null;
        if (reason) void this.closePipe(socket, pipeId, reason, true);
      }
    }
  }
}

function uuidBuffer(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function uuidString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
}

/**
 * Client side: `GET /v1/next/relay/client` (WebSocket). The first text message is
 * `{type: "pipe_auth", access_token, collection, grant, device, device_noise_pk}`, the
 * target device and its Noise key as the routing endpoint returned them; after `pipe_opened`, binary
 * frames are the client's §12.3 stream bytes. Close codes: 4401 unauthenticated,
 * 4403 grant_inactive, 4404 connector_offline, 4429 connector_busy, 4000 any other
 * close with the reason as text.
 */
export function registerNoisePipeClientRoute(
  app: FastifyInstance,
  options: { db: DatabasePool; broker: RelayBroker; limits?: NoisePipeLimits }
): void {
  const limits = options.limits ?? DEFAULT_NOISE_PIPE_LIMITS;
  app.get("/v1/next/relay/client", { websocket: true }, (socket) => {
    const closeWith = (reason: string) => {
      const code = { unauthenticated: 4401, grant_inactive: 4403, connector_offline: 4404, connector_busy: 4429 }[reason] ?? 4000;
      if (socket.readyState < 2) socket.close(code, reason);
    };
    const authTimer = setTimeout(() => closeWith("unauthenticated"), limits.authTimeoutMs);
    let pipeId: string | undefined;
    let inbound: RelayBrokerBinding | undefined;
    let opened = false;
    socket.once("close", () => {
      clearTimeout(authTimer);
      void inbound?.close();
      if (pipeId && opened) void options.broker.publishPipe(pipeSubject(pipeId, "device"), closeFrame("client_closed")).catch(() => undefined);
    });
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (opened && pipeId) {
        if (!isBinary || raw.length > MAX_PIPE_PAYLOAD) return closeWith("invalid_frame");
        void options.broker.publishPipe(pipeSubject(pipeId, "device"), frame(DATA, raw)).catch(() => closeWith("connector_offline"));
        return;
      }
      if (pipeId || isBinary) return closeWith("unauthenticated");
      pipeId = randomUUID();
      void admit(raw.toString("utf8"), pipeId).catch(() => closeWith("connector_offline"));
    });

    async function admit(text: string, id: string): Promise<void> {
      let auth: { type?: unknown; access_token?: unknown; collection?: unknown; grant?: unknown; device?: unknown; device_noise_pk?: unknown };
      try {
        auth = JSON.parse(text) as typeof auth;
      } catch {
        return closeWith("unauthenticated");
      }
      if (auth.type !== "pipe_auth" || typeof auth.access_token !== "string" || typeof auth.collection !== "string" || typeof auth.grant !== "string"
        || typeof auth.device !== "string" || typeof auth.device_noise_pk !== "string" || !/^[0-9a-f]{64}$/.test(auth.device_noise_pk)) {
        return closeWith("unauthenticated");
      }
      const admitted = await options.db.query<{ connector_id: string }>(
        `SELECT col.connector_id
         FROM access_tokens tok
         JOIN grants g ON g.id = tok.grant_id
         JOIN users u ON u.id = g.user_id
         JOIN collections col ON col.id = g.collection_id
         JOIN next_grant_client_keys k ON k.grant_id = g.id
         WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
           AND g.id::text = $3 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
           AND u.suspended_at IS NULL
           AND col.local_id = $2 AND col.enabled = true
           AND col.present = true AND col.authority_state = 'active'`,
        [tokenHash(auth.access_token), auth.collection, auth.grant]
      );
      const connectorId = admitted.rows[0]?.connector_id;
      if (!connectorId) return closeWith("grant_inactive");
      const generation = await currentRelayGeneration(options.db, connectorId);
      if (!generation) return closeWith("connector_offline");
      clearTimeout(authTimer);
      const openTimer = setTimeout(() => closeWith("connector_offline"), limits.openTimeoutMs);
      inbound = await options.broker.subscribePipe(pipeSubject(id, "client"), (message) => {
        if (message.length === 0 || socket.readyState !== 1) return;
        if (message[0] === OPENED && !opened) {
          clearTimeout(openTimer);
          opened = true;
          socket.send(JSON.stringify({ type: "pipe_opened", pipe_id: id }));
        } else if (message[0] === DATA && opened) {
          socket.send(Buffer.from(message.subarray(1)));
        } else if (message[0] === CLOSE) {
          clearTimeout(openTimer);
          opened = false;
          closeWith(Buffer.from(message.subarray(1)).toString("utf8"));
        }
      });
      await options.broker.publishPipe(
        pipeSubject("open", connectorId, generation),
        Buffer.from(JSON.stringify({ pipe_id: id, collection_id: auth.collection, grant_id: auth.grant, device_id: auth.device, device_noise_pk: auth.device_noise_pk }))
      );
    }
  });
}
