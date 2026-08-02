import { randomUUID } from "node:crypto";
import type {
  ApplicationProvisions,
  ApplicationRequirements,
  AuthorizationActivationResponse,
  AuthorizationOfferResponse,
  ContractSetupChoice,
  EncryptedRelayEnvelope,
  EncryptedRelayOperationRequest,
  EncryptedRelayOperationResponse,
  GrantPolicy,
  GrantScope,
  ApplicationAuthorizationProof,
  FirstContactBinding,
  ConnectProblem,
  RelayFileFrame
} from "@mdbase-dev/connect-protocol";
import {
  CONTROL_PROTOCOL_VERSION,
  CONTRACT_SETUP_CAPABILITY,
  isConnectProblem,
  normalizeConnectProblem,
  RELAY_CAPABILITIES,
  RELAY_REQUIRED_CAPABILITIES
} from "@mdbase-dev/connect-protocol";
import type { DatabasePool } from "./db.js";
import {
  LocalRelayBroker,
  RelayBrokerUnavailableError,
  type RelayBroker,
  type RelayBrokerBinding,
  type RelayBrokerCommand,
  type RelayBrokerReply
} from "./relay-broker.js";
import {
  ConnectorOperationError,
  RelayUnavailableError
} from "./relay-errors.js";
import { RelayFileBridge } from "./relay-file.js";
import { canonicalSha256 } from "./canonical-json.js";
import type { WebSocket } from "ws";

export { ConnectorOperationError, RelayUnavailableError } from "./relay-errors.js";

const OPERATION_TIMEOUT_MS = 30_000;
const BROKER_OPERATION_TIMEOUT_MS = OPERATION_TIMEOUT_MS + 1_000;
const OFFER_TIMEOUT_MS = 3_000;
const BROKER_OFFER_TIMEOUT_MS = OFFER_TIMEOUT_MS + 1_000;
const POLICY_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const INCOMPATIBLE_CLOSE_CODE = 4406;
const CONNECTOR_UPDATE_URL = "https://github.com/mdbase-dev/mdbase-connect/releases/latest";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  socket: WebSocket;
  expectedEncrypted?: EncryptedRelayEnvelope;
  expectedType?:
    | "operation_response"
    | "authorization_offer_response"
    | "authorization_activation_response"
    | "policy_applied";
  expectedPolicyRevision?: string;
}

interface ConnectorSession {
  generation: string;
  socket: WebSocket;
  binding: RelayBrokerBinding;
  capabilities: string[];
}

interface RelayHello {
  protocol_version: number;
  connector_version: string;
  capabilities: string[];
}

export class RelayHub {
  private readonly connectors = new Map<string, ConnectorSession>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly files: RelayFileBridge;

  constructor(
    private readonly db: DatabasePool,
    private readonly broker: RelayBroker = new LocalRelayBroker()
  ) {
    this.files = new RelayFileBridge(
      broker,
      (connectorId) => this.connectors.get(connectorId),
      (connectorId) => this.currentGeneration(connectorId)
    );
  }

  beginHandshake(socket: WebSocket): Promise<RelayHello | null> {
    return receiveRelayHello(socket);
  }

  async attach(
    connectorId: string,
    socket: WebSocket,
    handshake: Promise<RelayHello | null> = receiveRelayHello(socket)
  ): Promise<void> {
    const hello = await handshake;
    if (!hello
        || hello.protocol_version !== CONTROL_PROTOCOL_VERSION
        || !RELAY_REQUIRED_CAPABILITIES.every((capability) => hello.capabilities.includes(capability))) {
      rejectIncompatibleRelay(socket);
      return;
    }
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
      handleBinary: (frame) => this.files.handleBrokerCommand(connectorId, generation, frame),
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
    session = { generation, socket, binding, capabilities: [...hello.capabilities] };

    const previous = this.connectors.get(connectorId);
    this.connectors.set(connectorId, session);
    if (previous) {
      previous.socket.close(4001, "Replaced by a newer connector session");
      await previous.binding.close();
    }

    socket.on("message", (raw, isBinary) => {
      try {
        if (isBinary) {
          this.files.handleConnectorResponse(socket, raw);
          return;
        }
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          request_id?: string;
          ok?: boolean;
          result?: unknown;
          error?: { code?: string; message?: string };
          problem?: unknown;
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
          paused?: boolean;
          collections?: unknown[];
          contracts?: unknown[];
          revision?: string;
        };
        if (message.protocol_version !== CONTROL_PROTOCOL_VERSION) {
          rejectIncompatibleRelay(socket);
          return;
        }
        if (!message.request_id) return;
        const pending = this.pending.get(message.request_id);
        if (!pending || pending.socket !== socket) return;
        if (message.type === "encrypted_operation_rejected") {
          const problem = message.problem;
          if (!isConnectProblem(problem)) {
            this.rejectPending(
              message.request_id,
              new ConnectorOperationError(
                "invalid_relay_response",
                "The connector returned an invalid rejection problem."
              )
            );
            return;
          }
          this.rejectPending(
            message.request_id,
            ConnectorOperationError.fromProblem(problem)
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
        if (message.type === "authorization_offer_response") {
          if (pending.expectedType !== "authorization_offer_response") {
            this.rejectPending(
              message.request_id,
              new ConnectorOperationError(
                "invalid_relay_response",
                "The connector returned the wrong relay response type."
              )
            );
            return;
          }
          this.resolvePending(message.request_id, message);
          return;
        }
        if (message.type === "authorization_activation_response") {
          if (pending.expectedType !== "authorization_activation_response") {
            this.rejectPending(
              message.request_id,
              new ConnectorOperationError(
                "invalid_relay_response",
                "The connector returned the wrong relay response type."
              )
            );
            return;
          }
          if (message.ok) this.resolvePending(message.request_id, message);
          else {
            this.rejectPending(
              message.request_id,
              new ConnectorOperationError(
                message.error?.code ?? "authorization_activation_failed",
                message.error?.message ?? "The connector could not activate this authorization."
              )
            );
          }
          return;
        }
        if (message.type === "policy_applied") {
          if (pending.expectedType !== "policy_applied"
              || message.revision !== pending.expectedPolicyRevision) {
            this.rejectPending(
              message.request_id,
              new ConnectorOperationError(
                "invalid_policy_acknowledgement",
                "The connector acknowledged a different policy revision."
              )
            );
            return;
          }
          if (message.ok) this.resolvePending(message.request_id, message);
          else {
            this.rejectPending(
              message.request_id,
              new ConnectorOperationError(
                message.error?.code ?? "policy_apply_failed",
                message.error?.message ?? "The connector could not apply its policy."
              )
            );
          }
          return;
        }
        if (message.type !== "operation_response") return;
        if (pending.expectedType !== "operation_response") {
          this.rejectPending(
            message.request_id,
            new ConnectorOperationError(
              "invalid_relay_response",
              "The connector returned the wrong relay response type."
            )
          );
          return;
        }
        if (message.ok) this.resolvePending(message.request_id, message.result);
        else {
          const problem = message.problem;
          if (!isConnectProblem(problem)) {
            this.rejectPending(
              message.request_id,
              new ConnectorOperationError(
                "invalid_relay_response",
                "The connector returned an invalid operation problem."
              )
            );
            return;
          }
          this.rejectPending(
            message.request_id,
            ConnectorOperationError.fromProblem(problem)
          );
        }
      } catch {
        socket.close(4002, "Invalid relay message");
      }
    });

    socket.send(JSON.stringify({
      type: "relay_welcome",
      protocol_version: CONTROL_PROTOCOL_VERSION,
      session_id: generation,
      capabilities: [...RELAY_CAPABILITIES]
    }));
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
      scope: GrantScope;
      encryption: unknown | null;
      file_capability: unknown | null;
      application_authorization: ApplicationAuthorizationProof;
      first_contact: FirstContactBinding;
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
              g.encryption, g.file_capability, g.application_authorization,
              g.first_contact, g.notification_criteria, g.created_at
       FROM grants g
       JOIN collections c ON c.id = g.collection_id
       JOIN applications a ON a.id = g.application_id
       WHERE c.connector_id = $1 AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL`,
      [connectorId]
    );
    const generation = await this.currentGeneration(connectorId);
    if (!generation) return;
    const policyGrants = grants.rows.map((grant) => ({
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
      ...(grant.encryption ? { encryption: grant.encryption } : {}),
      ...(grant.file_capability ? { file_capability: grant.file_capability } : {}),
      first_contact: grant.first_contact,
      application_authorization: grant.application_authorization
    }));
    const message = {
      type: "policy_snapshot",
      protocol_version: CONTROL_PROTOCOL_VERSION,
      request_id: randomUUID(),
      revision: canonicalSha256(policyGrants),
      grants: policyGrants
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
    requestId: string;
    grantId: string;
    applicationId: string;
    operation: string;
    operationInput: unknown;
  }): Promise<unknown> {
    const generation = await this.requireCurrentGeneration(input.connectorId);
    return this.deliver(input.connectorId, generation, {
      type: "operation_request",
      protocol_version: CONTROL_PROTOCOL_VERSION,
      request_id: input.requestId,
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

  async routeFile(
    connectorId: string,
    request: RelayFileFrame
  ): Promise<RelayFileFrame> {
    return this.files.route(connectorId, request);
  }

  async authorizationOffers(
    connectorId: string,
    authorizationId: string,
    requirements: ApplicationRequirements,
    provisions: ApplicationProvisions
  ): Promise<AuthorizationOfferResponse> {
    const generation = await this.requireCurrentGeneration(connectorId);
    const requestId = randomUUID();
    const response = await this.deliver(connectorId, generation, {
      type: "authorization_offer_request",
      protocol_version: CONTROL_PROTOCOL_VERSION,
      request_id: requestId,
      authorization_id: authorizationId,
      requirements,
      provisions
    }, BROKER_OFFER_TIMEOUT_MS);
    return response as AuthorizationOfferResponse;
  }

  async activateAuthorization(
    connectorId: string,
    input: {
      authorizationId: string;
      collectionId: string;
      requirements: ApplicationRequirements;
      provisions: ApplicationProvisions;
      contractSetups: ContractSetupChoice[];
      grant: GrantPolicy;
    }
  ): Promise<AuthorizationActivationResponse> {
    const generation = await this.requireCurrentGeneration(connectorId);
    const requestId = randomUUID();
    const response = await this.deliver(connectorId, generation, {
      type: "authorization_activation_request",
      protocol_version: CONTROL_PROTOCOL_VERSION,
      request_id: requestId,
      authorization_id: input.authorizationId,
      collection_id: input.collectionId,
      requirements: input.requirements,
      provisions: input.provisions,
      contract_setups: input.contractSetups,
      grant: input.grant
    });
    return response as AuthorizationActivationResponse;
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
    this.files.close();
    await this.broker.close();
  }

  private async deliver(
    connectorId: string,
    generation: string,
    message: unknown,
    timeoutMs = BROKER_OPERATION_TIMEOUT_MS
  ): Promise<unknown> {
    let reply: RelayBrokerReply;
    try {
      reply = await this.broker.request(
        connectorId,
        generation,
        { version: 1, kind: "deliver", message },
        timeoutMs
      );
    } catch (error) {
      if (error instanceof RelayBrokerUnavailableError) throw new RelayUnavailableError();
      throw error;
    }
    if (reply.ok) return reply.value;
    if (reply.error.kind === "unavailable") throw new RelayUnavailableError();
    if (reply.error.kind === "connector") {
      throw ConnectorOperationError.fromProblem(reply.error.problem);
    }
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
    if (isContractSetupCommand(command.message)
        && !session.capabilities.includes(CONTRACT_SETUP_CAPABILITY)) {
      return brokerError(
        "connector",
        "connector_upgrade_required",
        "Update mdbase connect on the collection computer before approving contract setup."
      );
    }
    if (command.kind === "policy") {
      const requestId = requestIdFromMessage(command.message);
      const revision = policyRevisionFromMessage(command.message);
      if (!requestId || !revision) {
        return brokerError("internal", "invalid_policy_snapshot", "The policy snapshot was incomplete.");
      }
      try {
        const value = await this.sendToConnector(
          session.socket,
          requestId,
          command.message,
          undefined,
          "policy_applied",
          revision
        );
        return { version: 1, ok: true, value };
      } catch (error) {
        if (error instanceof RelayUnavailableError) {
          return brokerError("unavailable", "connector_offline", error.message);
        }
        if (error instanceof ConnectorOperationError) {
          return brokerProblem(error.problem);
        }
        return brokerError("internal", "policy_delivery_failed", "The connector could not apply its policy.");
      }
    }
    const requestId = requestIdFromMessage(command.message);
    if (!requestId) {
      return brokerError("internal", "invalid_relay_request", "The relay request did not contain a request ID.");
    }
    const expectedEncrypted = encryptedRequestFromMessage(command.message);
    const expectedType = expectedEncrypted
      ? undefined
      : expectedResponseType(command.message);
    try {
      const value = await this.sendToConnector(
        session.socket,
        requestId,
        command.message,
        expectedEncrypted,
        expectedType
      );
      return { version: 1, ok: true, value };
    } catch (error) {
      if (error instanceof RelayUnavailableError) {
        return brokerError("unavailable", "connector_offline", error.message);
      }
      if (error instanceof ConnectorOperationError) {
        return brokerProblem(error.problem);
      }
      return brokerError("internal", "relay_delivery_failed", "The relay could not deliver the request.");
    }
  }

  private sendToConnector(
    socket: WebSocket,
    requestId: string,
    message: unknown,
    expectedEncrypted?: EncryptedRelayEnvelope,
    expectedType?: PendingRequest["expectedType"],
    expectedPolicyRevision?: string
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
      }, expectedType === "authorization_offer_response"
        ? OFFER_TIMEOUT_MS
        : OPERATION_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        socket,
        expectedEncrypted,
        expectedType,
        expectedPolicyRevision
      });
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
    this.files.rejectForSocket(socket, error);
  }
}

function requestIdFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const requestId = (message as { request_id?: unknown }).request_id;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function isContractSetupCommand(message: unknown): boolean {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const candidate = message as { type?: unknown; contract_setups?: unknown };
  return candidate.type === "authorization_activation_request"
    && Array.isArray(candidate.contract_setups)
    && candidate.contract_setups.length > 0;
}

function policyRevisionFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const revision = (message as { revision?: unknown }).revision;
  return typeof revision === "string" && revision.length > 0 ? revision : null;
}

function encryptedRequestFromMessage(message: unknown): EncryptedRelayEnvelope | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  return (message as { type?: unknown }).type === "encrypted_operation_request"
    ? message as EncryptedRelayEnvelope
    : undefined;
}

function expectedResponseType(message: unknown): PendingRequest["expectedType"] {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  switch ((message as { type?: unknown }).type) {
    case "operation_request":
      return "operation_response";
    case "authorization_offer_request":
      return "authorization_offer_response";
    case "authorization_activation_request":
      return "authorization_activation_response";
    case "policy_snapshot":
      return "policy_applied";
    default:
      return undefined;
  }
}

async function receiveRelayHello(socket: WebSocket): Promise<RelayHello | null> {
  return new Promise((resolve) => {
    const finish = (value: RelayHello | null) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      resolve(value);
    };
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        finish(value.type === "relay_hello"
          && typeof value.protocol_version === "number"
          && typeof value.connector_version === "string"
          && Array.isArray(value.capabilities)
          && value.capabilities.every((capability) => typeof capability === "string")
          ? {
              protocol_version: value.protocol_version,
              connector_version: value.connector_version,
              capabilities: value.capabilities as string[]
            }
          : null);
      } catch {
        finish(null);
      }
    };
    const onClose = () => finish(null);
    const timer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

function rejectIncompatibleRelay(socket: WebSocket): void {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify({
    type: "relay_incompatible",
    protocol_version: CONTROL_PROTOCOL_VERSION,
    code: "connector_upgrade_required",
    message: "This mdbase Connect version is no longer compatible. Update the desktop app and reconnect.",
    update_url: CONNECTOR_UPDATE_URL
  }), () => socket.close(INCOMPATIBLE_CLOSE_CODE, "Connector upgrade required"));
}


function brokerError(
  kind: "unavailable" | "connector" | "internal",
  code: string,
  message: string
): RelayBrokerReply {
  if (kind === "connector") {
    return brokerProblem(normalizeConnectProblem(code, message));
  }
  return { version: 1, ok: false, error: { kind, code, message } };
}

function brokerProblem(problem: ConnectProblem): RelayBrokerReply {
  return { version: 1, ok: false, error: { kind: "connector", problem } };
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
