import { randomUUID } from "node:crypto";
import type {
  EncryptedRelayEnvelope,
  EncryptedRelayOperationRequest,
  EncryptedRelayOperationResponse
} from "@mdbase/connect-protocol";
import type { DatabasePool } from "./db.js";
import {
  LocalRelayBroker,
  RelayBrokerUnavailableError,
  type RelayBroker,
  type RelayBrokerBinding,
  type RelayBrokerCommand,
  type RelayBrokerReply
} from "./relay-broker.js";
import type { WebSocket } from "ws";

const OPERATION_TIMEOUT_MS = 30_000;
const BROKER_OPERATION_TIMEOUT_MS = OPERATION_TIMEOUT_MS + 1_000;
const POLICY_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  socket: WebSocket;
  expectedEncrypted?: EncryptedRelayEnvelope;
}

interface ConnectorSession {
  generation: string;
  socket: WebSocket;
  binding: RelayBrokerBinding;
}

export class RelayHub {
  private readonly connectors = new Map<string, ConnectorSession>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly db: DatabasePool,
    private readonly broker: RelayBroker = new LocalRelayBroker()
  ) {}

  async attach(connectorId: string, socket: WebSocket): Promise<void> {
    const updated = await this.db.query<{ relay_generation: string | number }>(
      `UPDATE connectors
       SET last_seen_at = now(), relay_generation = relay_generation + 1
       WHERE id = $1
       RETURNING relay_generation`,
      [connectorId]
    );
    const row = updated.rows[0];
    if (!row) {
      socket.close(4003, "Invalid connector credential");
      return;
    }
    const generation = String(row.relay_generation);
    let session: ConnectorSession;
    const binding = await this.broker.bind({
      connectorId,
      generation,
      handle: (command) => this.handleBrokerCommand(connectorId, generation, command),
      replaced: () => {
        const current = this.connectors.get(connectorId);
        if (current?.generation === generation && current.socket === socket) {
          socket.close(4001, "Replaced by a newer connector session");
        }
      }
    });
    if (await this.currentGeneration(connectorId) !== generation) {
      await binding.close();
      socket.close(4001, "Replaced by a newer connector session");
      return;
    }
    session = { generation, socket, binding };

    const previous = this.connectors.get(connectorId);
    this.connectors.set(connectorId, session);
    if (previous) {
      previous.socket.close(4001, "Replaced by a newer connector session");
      await previous.binding.close();
    }

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          request_id?: string;
          ok?: boolean;
          result?: unknown;
          error?: { code?: string; message?: string };
          protocol_version?: number;
          suite?: string;
          grant_id?: string;
          application_id?: string;
          connector_id?: string;
          collection_id?: string;
          operation?: string;
          scope_epoch?: number;
          key_id?: string;
          counter?: string;
          ciphertext?: string;
        };
        if (!message.request_id) return;
        const pending = this.pending.get(message.request_id);
        if (!pending || pending.socket !== socket) return;
        if (message.type === "encrypted_operation_rejected") {
          this.rejectPending(
            message.request_id,
            new ConnectorOperationError(
              "encrypted_relay_rejected",
              "The connector rejected the encrypted relay request."
            )
          );
          return;
        }
        if (pending.expectedEncrypted) {
          if (message.type !== "encrypted_operation_response"
              || !matchesEncryptedMetadata(
                message as Partial<EncryptedRelayOperationResponse>,
                pending.expectedEncrypted
              )) {
            this.rejectPending(
              message.request_id,
              new ConnectorOperationError(
                "invalid_encrypted_response",
                "The connector returned an invalid encrypted response."
              )
            );
            return;
          }
          this.resolvePending(message.request_id, message);
          return;
        }
        if (message.type !== "operation_response") return;
        if (message.ok) this.resolvePending(message.request_id, message.result);
        else {
          this.rejectPending(
            message.request_id,
            new ConnectorOperationError(
              message.error?.code ?? "connector_operation_failed",
              message.error?.message ?? "Connector operation failed."
            )
          );
        }
      } catch {
        socket.close(4002, "Invalid relay message");
      }
    });
    socket.once("close", () => {
      const current = this.connectors.get(connectorId);
      if (current?.socket === socket && current.generation === generation) {
        this.connectors.delete(connectorId);
      }
      void binding.close();
      this.rejectForSocket(socket, new RelayUnavailableError());
    });

    try {
      await this.broker.publishReplacement(connectorId, generation);
    } catch (error) {
      // The generation in PostgreSQL is the hard fence. Replacement broadcast
      // only accelerates closing a stale socket when the broker is available.
      if (!(error instanceof RelayBrokerUnavailableError)) throw error;
    }
    await this.pushPolicy(connectorId);
  }

  isConnected(connectorId: string): boolean {
    return this.connectors.get(connectorId)?.socket.readyState === 1;
  }

  async pushPolicy(connectorId: string): Promise<void> {
    const grants = await this.db.query<{
      id: string;
      application_id: string;
      application_name: string;
      application_distribution: "web" | "portable";
      application_homepage: string;
      application_project_url: string | null;
      application_origin: string;
      application_icon: string | null;
      local_id: string;
      collection_name: string;
      operations: string[];
      scope: {
        contracts: Array<{ id: string; version: number }>;
        access: "contract" | "full_collection";
      };
      encryption: unknown | null;
      notification_criteria: unknown[];
      created_at: string;
    }>(
      `SELECT g.id, g.application_id, a.name AS application_name,
              a.distribution AS application_distribution,
              a.homepage AS application_homepage,
              a.project_url AS application_project_url,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              a.icon AS application_icon,
              c.local_id, c.display_name AS collection_name, g.operations, g.scope,
              g.encryption, g.notification_criteria, g.created_at
       FROM grants g
       JOIN collections c ON c.id = g.collection_id
       JOIN applications a ON a.id = g.application_id
       WHERE c.connector_id = $1 AND g.revoked_at IS NULL`,
      [connectorId]
    );
    const generation = await this.currentGeneration(connectorId);
    if (!generation) return;
    const message = {
      type: "policy_snapshot",
      protocol_version: 1,
      grants: grants.rows.map((grant) => ({
        id: grant.id,
        application_id: grant.application_id,
        collection_id: grant.local_id,
        operations: grant.operations,
        scope: grant.scope,
        application_name: grant.application_name,
        application_distribution: grant.application_distribution,
        application_homepage: grant.application_homepage,
        ...(grant.application_project_url
          ? { application_project_url: grant.application_project_url }
          : {}),
        application_origin: grant.application_origin === "null"
          ? "null"
          : new URL(grant.application_origin).origin,
        application_icon: grant.application_icon,
        collection_name: grant.collection_name,
        notification_criteria: grant.notification_criteria,
        created_at: grant.created_at,
        ...(grant.encryption ? { encryption: grant.encryption } : {})
      }))
    };
    try {
      await this.broker.request(
        connectorId,
        generation,
        { version: 1, kind: "policy", message },
        POLICY_TIMEOUT_MS
      );
    } catch (error) {
      // Policy snapshots are best effort while a connector is offline. The
      // complete snapshot is sent again whenever the connector reconnects.
      if (!(error instanceof RelayBrokerUnavailableError)) throw error;
    }
  }

  async route(input: {
    connectorId: string;
    localCollectionId: string;
    grantId: string;
    applicationId: string;
    operation: string;
    operationInput: unknown;
  }): Promise<unknown> {
    const generation = await this.requireCurrentGeneration(input.connectorId);
    const requestId = randomUUID();
    return this.deliver(input.connectorId, generation, {
      type: "operation_request",
      protocol_version: 1,
      request_id: requestId,
      grant_id: input.grantId,
      collection_id: input.localCollectionId,
      application_id: input.applicationId,
      operation: input.operation,
      input: input.operationInput
    });
  }

  async routeEncrypted(
    connectorId: string,
    envelope: EncryptedRelayOperationRequest
  ): Promise<EncryptedRelayOperationResponse> {
    const generation = await this.requireCurrentGeneration(connectorId);
    const response = await this.deliver(connectorId, generation, envelope);
    if (!matchesEncryptedMetadata(
      response as Partial<EncryptedRelayOperationResponse>,
      envelope
    )) {
      throw new ConnectorOperationError(
        "invalid_encrypted_response",
        "The connector returned an invalid encrypted response."
      );
    }
    return response as EncryptedRelayOperationResponse;
  }

  async ready(): Promise<void> {
    await this.broker.ready();
  }

  async close(): Promise<void> {
    const sessions = [...this.connectors.values()];
    this.connectors.clear();
    await Promise.allSettled(sessions.map((session) => session.binding.close()));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RelayUnavailableError());
    }
    this.pending.clear();
    await this.broker.close();
  }

  private async deliver(
    connectorId: string,
    generation: string,
    message: unknown
  ): Promise<unknown> {
    let reply: RelayBrokerReply;
    try {
      reply = await this.broker.request(
        connectorId,
        generation,
        { version: 1, kind: "deliver", message },
        BROKER_OPERATION_TIMEOUT_MS
      );
    } catch (error) {
      if (error instanceof RelayBrokerUnavailableError) throw new RelayUnavailableError();
      throw error;
    }
    if (reply.ok) return reply.value;
    if (reply.error.kind === "unavailable") throw new RelayUnavailableError();
    throw new ConnectorOperationError(reply.error.code, reply.error.message);
  }

  private async handleBrokerCommand(
    connectorId: string,
    generation: string,
    command: RelayBrokerCommand
  ): Promise<RelayBrokerReply> {
    const session = this.connectors.get(connectorId);
    if (!session
        || session.generation !== generation
        || session.socket.readyState !== 1
        || await this.currentGeneration(connectorId) !== generation) {
      return brokerError("unavailable", "connector_offline", "The computer hosting this collection is offline.");
    }
    if (command.kind === "policy") {
      try {
        session.socket.send(JSON.stringify(command.message));
        return { version: 1, ok: true };
      } catch {
        return brokerError("unavailable", "connector_offline", "The computer hosting this collection is offline.");
      }
    }
    const requestId = requestIdFromMessage(command.message);
    if (!requestId) {
      return brokerError("internal", "invalid_relay_request", "The relay request did not contain a request ID.");
    }
    const expectedEncrypted = encryptedRequestFromMessage(command.message);
    try {
      const value = await this.sendToConnector(
        session.socket,
        requestId,
        command.message,
        expectedEncrypted
      );
      return { version: 1, ok: true, value };
    } catch (error) {
      if (error instanceof RelayUnavailableError) {
        return brokerError("unavailable", "connector_offline", error.message);
      }
      if (error instanceof ConnectorOperationError) {
        return brokerError("connector", error.code, error.message);
      }
      return brokerError("internal", "relay_delivery_failed", "The relay could not deliver the request.");
    }
  }

  private sendToConnector(
    socket: WebSocket,
    requestId: string,
    message: unknown,
    expectedEncrypted?: EncryptedRelayEnvelope
  ): Promise<unknown> {
    if (this.pending.has(requestId)) {
      return Promise.reject(new ConnectorOperationError(
        "duplicate_request_id",
        "The encrypted request ID is already in use."
      ));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ConnectorOperationError(
          "connector_timeout",
          "The connector operation timed out."
        ));
      }, OPERATION_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer, socket, expectedEncrypted });
      try {
        socket.send(JSON.stringify(message), (error) => {
          if (error) this.rejectPending(requestId, new RelayUnavailableError());
        });
      } catch {
        this.rejectPending(requestId, new RelayUnavailableError());
      }
    });
  }

  private async currentGeneration(connectorId: string): Promise<string | null> {
    const result = await this.db.query<{ relay_generation: string | number }>(
      "SELECT relay_generation FROM connectors WHERE id = $1",
      [connectorId]
    );
    return result.rows[0] ? String(result.rows[0].relay_generation) : null;
  }

  private async requireCurrentGeneration(connectorId: string): Promise<string> {
    const generation = await this.currentGeneration(connectorId);
    if (!generation || generation === "0") throw new RelayUnavailableError();
    return generation;
  }

  private resolvePending(requestId: string, value: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(value);
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(error);
  }

  private rejectForSocket(socket: WebSocket, error: Error): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.socket === socket) this.rejectPending(requestId, error);
    }
  }
}

function requestIdFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const requestId = (message as { request_id?: unknown }).request_id;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function encryptedRequestFromMessage(message: unknown): EncryptedRelayEnvelope | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  return (message as { type?: unknown }).type === "encrypted_operation_request"
    ? message as EncryptedRelayEnvelope
    : undefined;
}

function brokerError(
  kind: "unavailable" | "connector" | "internal",
  code: string,
  message: string
): RelayBrokerReply {
  return { version: 1, ok: false, error: { kind, code, message } };
}

function matchesEncryptedMetadata(
  response: Partial<EncryptedRelayOperationResponse>,
  request: EncryptedRelayEnvelope
): response is EncryptedRelayOperationResponse {
  return response?.protocol_version === request.protocol_version
    && response.suite === request.suite
    && response.request_id === request.request_id
    && response.grant_id === request.grant_id
    && response.application_id === request.application_id
    && response.connector_id === request.connector_id
    && response.collection_id === request.collection_id
    && response.operation === request.operation
    && response.scope_epoch === request.scope_epoch
    && response.key_id === request.key_id
    && response.counter === request.counter
    && typeof response.ciphertext === "string";
}

export class RelayUnavailableError extends Error {
  constructor() {
    super("The computer hosting this collection is offline.");
  }
}

export class ConnectorOperationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
