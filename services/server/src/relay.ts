import { randomUUID } from "node:crypto";
import type {
  EncryptedRelayEnvelope,
  EncryptedRelayOperationRequest,
  EncryptedRelayOperationResponse
} from "@mdbase/connect-protocol";
import type { DatabasePool } from "./db.js";
import type { WebSocket } from "ws";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  expectedEncrypted?: EncryptedRelayEnvelope;
}

export class RelayHub {
  private readonly connectors = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly db: DatabasePool) {}

  async attach(connectorId: string, socket: WebSocket): Promise<void> {
    this.connectors.get(connectorId)?.close(4001, "Replaced by a newer connector session");
    this.connectors.set(connectorId, socket);
    await this.db.query("UPDATE connectors SET last_seen_at = now() WHERE id = $1", [connectorId]);
    await this.pushPolicy(connectorId);

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
        if (!pending) return;
        if (message.type === "encrypted_operation_rejected") {
          clearTimeout(pending.timer);
          this.pending.delete(message.request_id);
          pending.reject(new ConnectorOperationError(
            "encrypted_relay_rejected",
            "The connector rejected the encrypted relay request."
          ));
          return;
        }
        if (pending.expectedEncrypted) {
          if (message.type !== "encrypted_operation_response"
              || !matchesEncryptedMetadata(
                message as Partial<EncryptedRelayOperationResponse>,
                pending.expectedEncrypted
              )) {
            clearTimeout(pending.timer);
            this.pending.delete(message.request_id);
            pending.reject(new ConnectorOperationError(
              "invalid_encrypted_response",
              "The connector returned an invalid encrypted response."
            ));
            return;
          }
          clearTimeout(pending.timer);
          this.pending.delete(message.request_id);
          pending.resolve(message);
          return;
        }
        if (message.type !== "operation_response") return;
        clearTimeout(pending.timer);
        this.pending.delete(message.request_id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new ConnectorOperationError(
          message.error?.code ?? "connector_operation_failed",
          message.error?.message ?? "Connector operation failed."
        ));
      } catch {
        socket.close(4002, "Invalid relay message");
      }
    });
    socket.once("close", () => {
      if (this.connectors.get(connectorId) === socket) this.connectors.delete(connectorId);
    });
  }

  isConnected(connectorId: string): boolean {
    return this.connectors.get(connectorId)?.readyState === 1;
  }

  async pushPolicy(connectorId: string): Promise<void> {
    const socket = this.connectors.get(connectorId);
    if (!socket || socket.readyState !== 1) return;
    const grants = await this.db.query<{
      id: string;
      application_id: string;
      application_name: string;
      application_homepage: string;
      application_origin: string;
      application_icon: string | null;
      local_id: string;
      collection_name: string;
      operations: string[];
      scope: { contracts: Array<{ id: string; version: number }> };
      encryption: unknown | null;
      created_at: string;
    }>(
      `SELECT g.id, g.application_id, a.name AS application_name,
              a.homepage AS application_homepage,
              CASE WHEN g.application_origin = '' THEN a.homepage
                   ELSE g.application_origin END AS application_origin,
              a.icon AS application_icon,
              c.local_id, c.display_name AS collection_name, g.operations, g.scope,
              g.encryption, g.created_at
       FROM grants g
       JOIN collections c ON c.id = g.collection_id
       JOIN applications a ON a.id = g.application_id
       WHERE c.connector_id = $1 AND g.revoked_at IS NULL`,
      [connectorId]
    );
    socket.send(JSON.stringify({
      type: "policy_snapshot",
      protocol_version: 2,
      grants: grants.rows.map((grant) => ({
        id: grant.id,
        application_id: grant.application_id,
        collection_id: grant.local_id,
        operations: grant.operations,
        scope: grant.scope,
        application_name: grant.application_name,
        application_homepage: grant.application_homepage,
        application_origin: new URL(grant.application_origin).origin,
        application_icon: grant.application_icon,
        collection_name: grant.collection_name,
        created_at: grant.created_at,
        ...(grant.encryption ? { encryption: grant.encryption } : {})
      }))
    }));
  }

  route(input: {
    connectorId: string;
    localCollectionId: string;
    grantId: string;
    applicationId: string;
    operation: string;
    operationInput: unknown;
  }): Promise<unknown> {
    const socket = this.connectors.get(input.connectorId);
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new RelayUnavailableError());
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Connector operation timed out."));
      }, 30_000);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({
        type: "operation_request",
        protocol_version: 2,
        request_id: requestId,
        grant_id: input.grantId,
        collection_id: input.localCollectionId,
        application_id: input.applicationId,
        operation: input.operation,
        input: input.operationInput
      }));
    });
  }

  routeEncrypted(
    connectorId: string,
    envelope: EncryptedRelayOperationRequest
  ): Promise<EncryptedRelayOperationResponse> {
    const socket = this.connectors.get(connectorId);
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new RelayUnavailableError());
    }
    if (this.pending.has(envelope.request_id)) {
      return Promise.reject(new ConnectorOperationError(
        "duplicate_request_id",
        "The encrypted request ID is already in use."
      ));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.request_id);
        reject(new Error("Connector operation timed out."));
      }, 30_000);
      this.pending.set(envelope.request_id, {
        resolve,
        reject,
        timer,
        expectedEncrypted: envelope
      });
      socket.send(JSON.stringify(envelope));
    });
  }
}

function matchesEncryptedMetadata(
  response: Partial<EncryptedRelayOperationResponse>,
  request: EncryptedRelayEnvelope
): response is EncryptedRelayOperationResponse {
  return response.protocol_version === request.protocol_version
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
