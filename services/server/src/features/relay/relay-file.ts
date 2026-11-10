import type { RelayFileFrame } from "@mdbase-dev/connect-protocol";
import {
  decodeRelayFileFrame,
  encodeRelayFileFrame,
  FILE_RELAY_CAPABILITY,
  normalizeConnectProblem
} from "@mdbase-dev/connect-protocol";
import type { RawData, WebSocket } from "ws";
import type {
  RelayBroker,
  RelayBrokerBinaryReply
} from "./relay-broker.js";
import { RelayBrokerUnavailableError } from "./relay-broker.js";
import {
  ConnectorOperationError,
  RelayUnavailableError
} from "./relay-errors.js";

export interface RelayFileLimits {
  connectorTimeoutMs: number;
  brokerTimeoutMs: number;
  pendingPerGrant: number;
  pendingPerConnector: number;
  pendingProcess: number;
}

const DEFAULT_RELAY_FILE_LIMITS: RelayFileLimits = Object.freeze({
  connectorTimeoutMs: 30_000,
  brokerTimeoutMs: 31_000,
  pendingPerGrant: 8,
  pendingPerConnector: 16,
  pendingProcess: 256
});

interface RelayFileSession {
  generation: string;
  socket: WebSocket;
  capabilities: string[];
}

interface PendingFileRequest {
  resolve(value: RelayFileFrame): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  socket: WebSocket;
  connectorId: string;
  grantId: string;
  request: RelayFileFrame;
}

/** Routes bounded opaque file frames without mixing them into JSON relay state. */
export class RelayFileBridge {
  private readonly pending = new Map<string, PendingFileRequest>();

  constructor(
    private readonly broker: RelayBroker,
    private readonly sessionFor: (connectorId: string) => RelayFileSession | undefined,
    private readonly currentGeneration: (connectorId: string) => Promise<string | null>,
    private readonly limits: RelayFileLimits = DEFAULT_RELAY_FILE_LIMITS
  ) {
    validateLimits(limits);
  }

  async route(connectorId: string, request: RelayFileFrame): Promise<RelayFileFrame> {
    if (request.kind !== "upload_chunk" && request.kind !== "download_request") {
      throw new ConnectorOperationError(
        "invalid_relay_file_message",
        "The file relay request kind is invalid."
      );
    }
    const generation = await this.requireCurrentGeneration(connectorId);
    let reply: RelayBrokerBinaryReply;
    try {
      reply = await this.broker.requestBinary(
        connectorId,
        generation,
        encodeRelayFileFrame(request),
        this.limits.brokerTimeoutMs
      );
    } catch (error) {
      if (error instanceof RelayBrokerUnavailableError) throw new RelayUnavailableError();
      throw error;
    }
    if (!reply.ok) {
      if (reply.error.kind === "unavailable") throw new RelayUnavailableError();
      if (reply.error.kind === "connector") {
        throw ConnectorOperationError.fromProblem(reply.error.problem);
      }
      throw new ConnectorOperationError(reply.error.code, reply.error.message);
    }
    let response: RelayFileFrame;
    try {
      response = decodeRelayFileFrame(reply.value);
    } catch {
      throw new ConnectorOperationError(
        "invalid_relay_file_response",
        "The connector returned an invalid binary file response."
      );
    }
    if (!matchesFileResponse(request, response)) {
      throw new ConnectorOperationError(
        "invalid_relay_file_response",
        "The connector returned a response for a different file chunk."
      );
    }
    if (response.kind === "rejected") {
      throw new ConnectorOperationError(
        "file_transfer_rejected",
        "The connector rejected this file transfer request."
      );
    }
    return response;
  }

  async handleBrokerCommand(
    connectorId: string,
    generation: string,
    encoded: Uint8Array
  ): Promise<RelayBrokerBinaryReply> {
    const session = this.sessionFor(connectorId);
    if (!session
        || session.generation !== generation
        || session.socket.readyState !== 1
        || await this.currentGeneration(connectorId) !== generation) {
      return binaryBrokerError(
        "unavailable",
        "connector_offline",
        "The computer hosting this collection is offline."
      );
    }
    if (!session.capabilities.includes(FILE_RELAY_CAPABILITY)) {
      return binaryBrokerError(
        "connector",
        "connector_upgrade_required",
        "Update mdbase connect before relaying collection files."
      );
    }
    let request: RelayFileFrame;
    try {
      request = decodeRelayFileFrame(encoded);
    } catch {
      return binaryBrokerError(
        "internal",
        "invalid_relay_file_message",
        "The relayed file message was invalid."
      );
    }
    if (request.kind !== "upload_chunk" && request.kind !== "download_request") {
      return binaryBrokerError(
        "internal",
        "invalid_relay_file_message",
        "The relayed file request kind was invalid."
      );
    }
    try {
      const response = await this.send(connectorId, session.socket, request);
      return { version: 1, ok: true, value: encodeRelayFileFrame(response) };
    } catch (error) {
      if (error instanceof RelayUnavailableError) {
        return binaryBrokerError("unavailable", "connector_offline", error.message);
      }
      if (error instanceof ConnectorOperationError) {
        return { version: 1, ok: false, error: { kind: "connector", problem: error.problem } };
      }
      return binaryBrokerError(
        "internal",
        "relay_file_delivery_failed",
        "The relay could not deliver the file message."
      );
    }
  }

  handleConnectorResponse(socket: WebSocket, raw: RawData): void {
    let response: RelayFileFrame;
    try {
      response = decodeRelayFileFrame(websocketBytes(raw));
    } catch {
      socket.close(4002, "Invalid relay file message");
      return;
    }
    const pending = this.pending.get(response.header.request_id);
    if (!pending || pending.socket !== socket) return;
    if (!matchesFileResponse(pending.request, response)) {
      this.reject(
        response.header.request_id,
        new ConnectorOperationError(
          "invalid_relay_file_response",
          "The connector returned a response for a different file chunk."
        )
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.header.request_id);
    pending.resolve(response);
  }

  rejectForSocket(socket: WebSocket, error: Error): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.socket === socket) this.reject(requestId, error);
    }
  }

  close(error = new RelayUnavailableError()): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(
    connectorId: string,
    socket: WebSocket,
    request: RelayFileFrame
  ): Promise<RelayFileFrame> {
    const requestId = request.header.request_id;
    if (this.pending.has(requestId)) {
      return Promise.reject(new ConnectorOperationError(
        "duplicate_request_id",
        "The file relay request ID is already in use."
      ));
    }
    const connectorPending = countPending(
      this.pending.values(),
      (pending) => pending.connectorId === connectorId
    );
    const grantPending = countPending(
      this.pending.values(),
      (pending) => pending.connectorId === connectorId
        && pending.grantId === request.header.grant_id
    );
    if (grantPending >= this.limits.pendingPerGrant) {
      return Promise.reject(new ConnectorOperationError(
        "rate_limited",
        "This grant is already processing its maximum number of file chunks."
      ));
    }
    if (connectorPending >= this.limits.pendingPerConnector) {
      return Promise.reject(new ConnectorOperationError(
        "rate_limited",
        "The connector is already processing its maximum number of file chunks."
      ));
    }
    if (this.pending.size >= this.limits.pendingProcess) {
      return Promise.reject(new ConnectorOperationError(
        "rate_limited",
        "The file relay is temporarily at capacity."
      ));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ConnectorOperationError(
          "connector_timeout",
          "The connector file operation timed out."
        ));
      }, this.limits.connectorTimeoutMs);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        socket,
        connectorId,
        grantId: request.header.grant_id,
        request
      });
      try {
        socket.send(encodeRelayFileFrame(request), { binary: true }, (error) => {
          if (error) this.reject(requestId, new RelayUnavailableError());
        });
      } catch {
        this.reject(requestId, new RelayUnavailableError());
      }
    });
  }

  private reject(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error);
  }

  private async requireCurrentGeneration(connectorId: string): Promise<string> {
    const generation = await this.currentGeneration(connectorId);
    if (!generation || generation === "0") throw new RelayUnavailableError();
    return generation;
  }
}

function validateLimits(limits: RelayFileLimits): void {
  const values = Object.values(limits);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)
      || limits.pendingPerGrant > limits.pendingPerConnector
      || limits.pendingPerConnector > limits.pendingProcess
      || limits.brokerTimeoutMs <= limits.connectorTimeoutMs) {
    throw new TypeError("Relay file limits are inconsistent.");
  }
}

function countPending(
  pending: IterableIterator<PendingFileRequest>,
  matches: (request: PendingFileRequest) => boolean
): number {
  let count = 0;
  for (const request of pending) {
    if (matches(request)) count += 1;
  }
  return count;
}

function matchesFileResponse(request: RelayFileFrame, response: RelayFileFrame): boolean {
  const expected = request.kind === "upload_chunk"
    ? "upload_acknowledged"
    : "download_chunk";
  return (response.kind === expected || response.kind === "rejected")
    && response.header.request_id === request.header.request_id
    && response.header.grant_id === request.header.grant_id
    && response.header.transfer_id === request.header.transfer_id
    && response.header.chunk_index === request.header.chunk_index;
}

function websocketBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function binaryBrokerError(
  kind: "unavailable" | "connector" | "internal",
  code: string,
  message: string
): RelayBrokerBinaryReply {
  if (kind === "connector") {
    return {
      version: 1,
      ok: false,
      error: {
        kind: "connector",
        problem: normalizeConnectProblem(code, message)
      }
    };
  }
  return { version: 1, ok: false, error: { kind, code, message } };
}
