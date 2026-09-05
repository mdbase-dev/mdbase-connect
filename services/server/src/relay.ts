import { randomUUID } from "node:crypto";
import type { ApplicationRequirements } from "./application-requirements.js";
import type {
  ApplicationProvisions, AuthorizationActivationResponse,
  AuthorizationOfferResponse, ConnectContractRequirements, ContractSetupChoice,
  EncryptedRelayEnvelope, EncryptedRelayOperationRequest, EncryptedRelayOperationResponse,
  GrantPolicy, RelayFileFrame
} from "@mdbase-dev/connect-protocol";
import {
  CONNECT_CONTRACT_SUPPORT, CONTRACT_SETUP_CAPABILITY, CONTROL_PROTOCOL_VERSION,
  isConnectProblem, MINIMUM_CONNECTOR_VERSION, normalizeConnectProblem,
  OPERATION_TRANSPORT_PROTOCOL_VERSION,
  POLICY_FRESHNESS_LEASE_CAPABILITY,
  POLICY_FRESHNESS_LEASE_MINIMUM_CONNECTOR_VERSION,
  PROTOCOL_USAGE_REPORT_CAPABILITY, RELAY_CAPABILITIES
} from "@mdbase-dev/connect-protocol";
import type { DatabasePool } from "./db.js";
import {
  LocalRelayBroker, RelayBrokerUnavailableError, type RelayBroker,
  type RelayBrokerCommand, type RelayBrokerReply
} from "./relay-broker.js";
import { ConnectorOperationError, RelayUnavailableError } from "./relay-errors.js";
import { RelayFileBridge } from "./relay-file.js";
import { observeConnectorPolicyStage, reportConnectorRelayClose, resolvePolicyAppliedAck, type PolicyMode } from "./relay-policy.js";
import {
  ExactPolicyPublisher, handlePolicyPushCommand, RelayPolicySession,
  requestPolicyPush, type ExactPolicyAcknowledgement
} from "./relay-policy-session.js";
import type { WebSocket } from "ws";
import { recordConnectorProtocolUsage } from "./protocol-telemetry.js";
import {
  CONNECTOR_UPDATE_URL, receiveRelayHello, rejectIncompatibleRelay,
  relayCapabilityMismatch, relayContractMismatch, type RelayHello
} from "./relay-compatibility.js";
import { grantIdFromMessage, hasPendingOperationCapacity } from "./relay-admission.js";
import {
  brokerError, brokerProblem, encryptedRequestFromMessage, expectedResponseType,
  isContractSetupCommand, matchesEncryptedMetadata, relayExecutionTimeoutProblem,
  relayMessageMayMutate, requestIdFromMessage, validProtocolUsageEntries
} from "./relay-routing.js";
import type {
  ConnectorRelaySession as ConnectorSession,
  PendingRelayRequest as PendingRequest
} from "./relay-session.js";

export { ConnectorOperationError, RelayUnavailableError } from "./relay-errors.js";
export { connectorVersionAtLeast } from "./relay-compatibility.js";
export { relayExecutionTimeoutProblem } from "./relay-routing.js";

const OPERATION_TIMEOUT_MS = 30_000;
const BROKER_OPERATION_TIMEOUT_MS = OPERATION_TIMEOUT_MS + 1_000;
const OFFER_TIMEOUT_MS = 3_000;
const POLICY_ACK_TIMEOUT_MS = 5_000;
const BROKER_OFFER_TIMEOUT_MS = OFFER_TIMEOUT_MS + 1_000;
// Keep a 5s clock-skew margin within the connector's 60s authority horizon.
const POLICY_LEASE_MS = 55_000;

export class RelayHub {
  private readonly connectors = new Map<string, ConnectorSession>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly detachedPolicyPushes = new Set<Promise<void>>();
  private readonly files: RelayFileBridge;
  private readonly leasePolicyPublisher: ExactPolicyPublisher;
  private readonly legacyPolicyPublisher: ExactPolicyPublisher;
  private closed = false;

  constructor(
    private readonly db: DatabasePool,
    private readonly broker: RelayBroker = new LocalRelayBroker()
  ) {
    this.files = new RelayFileBridge(
      broker,
      (connectorId) => {
        const session = this.connectors.get(connectorId);
        return session?.ready ? session : undefined;
      },
      (connectorId) => this.currentGeneration(connectorId)
    );
    this.leasePolicyPublisher = new ExactPolicyPublisher(
      db, POLICY_LEASE_MS, (connectorId) => this.currentGeneration(connectorId),
      () => !this.closed, "lease_v1"
    );
    this.legacyPolicyPublisher = new ExactPolicyPublisher(
      db, POLICY_LEASE_MS, (connectorId) => this.currentGeneration(connectorId),
      () => !this.closed, "legacy_ack_v0"
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
    const contractMismatch = hello
      ? relayContractMismatch(hello.contract_support)
      : undefined;
    const capabilityMismatch = hello
      ? relayCapabilityMismatch(hello.capabilities)
      : undefined;
    if (!hello
        || hello.protocol_version !== CONTROL_PROTOCOL_VERSION
        || contractMismatch
        || capabilityMismatch) {
      try {
        if (!this.isConnected(connectorId)) {
          await this.db.query(
            `UPDATE connectors
             SET connector_version = $2,
                 last_incompatible_at = now(),
                 incompatibility_code = $3,
                 minimum_connector_version = $4,
                 connector_update_url = $5
             WHERE id = $1`,
            [
              connectorId,
              hello?.connector_version ?? null,
              contractMismatch?.code
                ?? capabilityMismatch?.code
                ?? "connector_upgrade_required",
              MINIMUM_CONNECTOR_VERSION,
              CONNECTOR_UPDATE_URL
            ]
          );
        }
      } finally {
        rejectIncompatibleRelay(socket, contractMismatch ?? capabilityMismatch);
      }
      return;
    }
    const mode: PolicyMode = hello.capabilities.includes(POLICY_FRESHNESS_LEASE_CAPABILITY)
      ? "lease_v1"
      : "legacy_ack_v0";
    const updated = await this.db.query<{ relay_generation: string | number }>(
      `UPDATE connectors
       SET last_seen_at = now(), relay_generation = relay_generation + 1,
           connector_version = $2,
           policy_lease_negotiated_at = CASE
             WHEN $3 = 'lease_v1'
               THEN COALESCE(policy_lease_negotiated_at, now())
             ELSE policy_lease_negotiated_at END,
           latest_policy_mode = $3,
           latest_policy_mode_at = now(),
           last_incompatible_at = NULL,
           incompatibility_code = NULL,
           minimum_connector_version = CASE WHEN $3 = 'legacy_ack_v0' THEN $4 ELSE NULL END,
           connector_update_url = CASE WHEN $3 = 'legacy_ack_v0' THEN $5 ELSE NULL END
       WHERE id = $1 AND revoked_at IS NULL
         AND ($3 = 'lease_v1' OR (
           policy_lease_negotiated_at IS NULL
           AND policy_lease_adopted_at IS NULL
         ))
         AND user_id IN (SELECT id FROM users WHERE suspended_at IS NULL)
       RETURNING relay_generation`,
      [connectorId, hello.connector_version, mode,
        POLICY_FRESHNESS_LEASE_MINIMUM_CONNECTOR_VERSION, CONNECTOR_UPDATE_URL]
    );
    const row = updated.rows[0];
    if (!row) {
      const leaseBoundary = await this.db.query<{
        policy_lease_negotiated_at: Date | null;
        policy_lease_adopted_at: Date | null;
      }>(
        `SELECT c.policy_lease_negotiated_at, c.policy_lease_adopted_at FROM connectors c
         JOIN users u ON u.id = c.user_id
         WHERE c.id = $1 AND c.revoked_at IS NULL AND u.suspended_at IS NULL`,
        [connectorId]
      );
      if (mode === "legacy_ack_v0" && (
        leaseBoundary.rows[0]?.policy_lease_negotiated_at
        || leaseBoundary.rows[0]?.policy_lease_adopted_at
      )) {
        if (!this.isConnected(connectorId)) {
          await this.db.query(
            `UPDATE connectors
             SET connector_version = $2,
                 last_incompatible_at = now(),
                 incompatibility_code = 'capability_contract_incompatible',
                 minimum_connector_version = $3,
                 connector_update_url = $4
             WHERE id = $1 AND revoked_at IS NULL
               AND (policy_lease_negotiated_at IS NOT NULL
                 OR policy_lease_adopted_at IS NOT NULL)
               AND user_id IN (
                 SELECT id FROM users WHERE suspended_at IS NULL
               )`,
            [connectorId, hello.connector_version,
              POLICY_FRESHNESS_LEASE_MINIMUM_CONNECTOR_VERSION, CONNECTOR_UPDATE_URL]
          );
        }
        rejectIncompatibleRelay(socket, {
          code: "capability_contract_incompatible",
          details: {
            contract: "relay_capability",
            required: [POLICY_FRESHNESS_LEASE_CAPABILITY],
            supported: hello.capabilities,
            peer: "connector"
          }
        }, POLICY_FRESHNESS_LEASE_MINIMUM_CONNECTOR_VERSION);
      } else socket.close(4003, "Invalid connector credential");
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
          this.connectors.delete(connectorId);
          current.policy.stop(new RelayUnavailableError());
          this.rejectForSocket(socket, new RelayUnavailableError());
          socket.close(4001, "Replaced by a newer connector session");
          void binding.close();
        }
      }
    });
    if (await this.currentGeneration(connectorId) !== generation) {
      await binding.close();
      socket.close(4001, "Replaced by a newer connector session");
      return;
    }
    const policy = new RelayPolicySession(
      { connectorId, generation, socket },
      {
        isActive: (identity) => !this.closed
          && this.connectors.get(identity.connectorId) === session
          && session.generation === identity.generation
          && session.socket === identity.socket
          && identity.socket.readyState === 1,
        push: (identity, isStillCurrent, initial) =>
          (mode === "lease_v1" ? this.leasePolicyPublisher : this.legacyPolicyPublisher).push(
            { connectorId: identity.connectorId, generation: identity.generation, isStillCurrent },
            (message) => this.sendToConnector(
              identity.socket, identity.connectorId, undefined, message.request_id,
              message, undefined, "policy_applied", message.revision, identity.generation,
              mode, initial
            )
          ),
        renewalFailed: () => {
          // Payload-free: connector identities and provider errors are not log data.
          console.warn("connector policy renewal failed", { class: "delivery_unavailable" });
        }
      },
      mode
    );
    session = {
      generation,
      socket,
      binding,
      capabilities: [...hello.capabilities],
      contractSupport: hello.contract_support,
      lastUsageReportAt: 0,
      mode,
      ready: false,
      changedPolicyRequested: 0,
      changedPolicySettled: 0,
      policy
    };

    const previous = this.connectors.get(connectorId);
    this.connectors.set(connectorId, session);
    if (previous) {
      previous.policy.stop(new RelayUnavailableError());
      previous.socket.close(4001, "Replaced by a newer connector session");
      this.rejectForSocket(previous.socket, new RelayUnavailableError());
      await Promise.allSettled([
        previous.binding.close(),
        previous.policy.waitForIdle()
      ]);
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
          error?: { code?: string; message?: string; details?: unknown };
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
          entries?: unknown[];
        };
        if (message.type === "protocol_usage_report") {
          if (
            message.protocol_version !== CONTROL_PROTOCOL_VERSION
            || !session.capabilities.includes(PROTOCOL_USAGE_REPORT_CAPABILITY)
            || !validProtocolUsageEntries(message.entries)
          ) {
            rejectIncompatibleRelay(socket);
            return;
          }
          const now = Date.now();
          if (now - session.lastUsageReportAt < 10_000) return;
          session.lastUsageReportAt = now;
          void recordConnectorProtocolUsage(
            this.db,
            connectorId,
            message.entries.map((entry) => ({
              version: entry.version,
              count: entry.count
            }))
          ).catch(() => undefined);
          return;
        }
        const pending = message.request_id
          ? this.pending.get(message.request_id)
          : undefined;
        const expectedProtocol = message.type === "encrypted_operation_response"
          || message.type === "encrypted_operation_rejected"
          ? pending?.expectedEncrypted?.protocol_version
            ?? OPERATION_TRANSPORT_PROTOCOL_VERSION
          : message.type === "operation_response"
            ? OPERATION_TRANSPORT_PROTOCOL_VERSION
            : CONTROL_PROTOCOL_VERSION;
        if (message.protocol_version !== expectedProtocol) {
          rejectIncompatibleRelay(socket);
          return;
        }
        if (!message.request_id) return;
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
                message.error?.message ?? "The connector could not activate this authorization.",
                undefined,
                message.error?.details
              )
            );
          }
          return;
        }
        if (message.type === "policy_applied") {
          void resolvePolicyAppliedAck({
            db: this.db,
            requestId: message.request_id,
            message,
            expectedRevision: pending.expectedPolicyRevision,
            connectorId: pending.expectedPolicyConnectorId,
            generation: pending.expectedPolicyGeneration,
            mode: pending.expectedPolicyMode!,
            initial: pending.expectedPolicyInitial === true,
            isStillCurrent: () => this.pending.get(message.request_id!) === pending
              && pending.socket === socket
              && this.connectors.get(pending.expectedPolicyConnectorId!)?.generation
                === pending.expectedPolicyGeneration
              && this.connectors.get(pending.expectedPolicyConnectorId!)?.socket === socket,
            resolve: () => this.resolvePending(message.request_id!, message),
            reject: (error) => this.rejectPending(message.request_id!, error)
          }).catch(() => this.rejectPending(message.request_id!, new ConnectorOperationError(
            "policy_acknowledgement_unavailable",
            "The policy acknowledgement could not be verified."
          )));
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
      capabilities: [...RELAY_CAPABILITIES],
      contract_support: CONNECT_CONTRACT_SUPPORT
    }));
    socket.once("close", (code) => {
      reportConnectorRelayClose(code, session.ready);
      const current = this.connectors.get(connectorId);
      if (current === session) this.connectors.delete(connectorId);
      session.policy.stop(new RelayUnavailableError());
      void binding.close();
      this.rejectForSocket(socket, new RelayUnavailableError());
    });

    try {
      await observeConnectorPolicyStage("replacement_broadcast", () =>
        this.broker.publishReplacement(connectorId, generation));
    } catch (error) {
      // The generation in PostgreSQL is the hard fence. Replacement broadcast
      // only accelerates closing a stale socket when the broker is available.
      if (!(error instanceof RelayBrokerUnavailableError)) throw error;
    }
    try {
      await observeConnectorPolicyStage("initial_policy", () => session.policy.start());
      if (this.connectors.get(connectorId) === session
          && session.generation === generation
          && session.socket === socket
          && session.changedPolicySettled === session.changedPolicyRequested) {
        session.ready = true;
      }
    } catch (error) {
      if (this.connectors.get(connectorId) === session) {
        this.connectors.delete(connectorId);
      }
      session.policy.stop(new RelayUnavailableError());
      socket.close(4003, "Initial connector policy unavailable");
      this.rejectForSocket(socket, new RelayUnavailableError());
      await Promise.allSettled([binding.close(), session.policy.waitForIdle()]);
      throw error;
    }
  }

  isConnected(connectorId: string): boolean {
    const session = this.connectors.get(connectorId);
    return session?.ready === true && session.socket.readyState === 1;
  }

  async fenceConnector(
    connectorId: string,
    fenceGeneration: string,
    reason = "Computer access was revoked"
  ): Promise<"closed" | "degraded"> {
    let degraded = false;
    const session = this.connectors.get(connectorId);
    if (session) {
      this.connectors.delete(connectorId);
      session.policy.stop(new RelayUnavailableError());
      this.rejectForSocket(session.socket, new RelayUnavailableError());
      try {
        session.socket.close(4003, reason);
        const results = await Promise.allSettled([
          session.binding.close(),
          session.policy.waitForIdle()
        ]);
        if (results.some((result) => result.status === "rejected")) degraded = true;
      } catch {
        degraded = true;
      }
    }
    try {
      await this.broker.publishReplacement(connectorId, fenceGeneration);
    } catch {
      degraded = true;
    }
    // PostgreSQL deletion/generation is already committed and is the hard
    // server fence. Cross-server socket closure is mandatory best effort; an
    // unreachable broker converges when the <=60s connector lease expires.
    return degraded ? "degraded" : "closed";
  }

  supportsContracts(
    connectorId: string,
    required: ConnectContractRequirements
  ): boolean {
    const session = this.connectors.get(connectorId);
    const support = session?.ready ? session.contractSupport : undefined;
    return Boolean(
      support
      && support.operation_transport.includes(required.operation_transport)
      && (required.operation_transport_recovery ?? []).every((version) =>
        support.operation_transport.includes(version))
      && support.authorization_binding.includes(required.authorization_binding)
      && support.semantic_capabilities.includes(required.semantic_capabilities)
      && (required.durable_mutation === undefined
        || support.durable_mutation.includes(required.durable_mutation))
    );
  }

  async pushPolicy(connectorId: string): Promise<void> {
    if (this.closed) throw new RelayUnavailableError();
    const session = this.connectors.get(connectorId);
    if (session) {
      await this.requestChangedPolicy(connectorId, session);
      return;
    }
    const generation = await this.currentGeneration(connectorId);
    if (!generation) return;
    const pushing = requestPolicyPush(this.broker, connectorId, generation);
    this.detachedPolicyPushes.add(pushing);
    try {
      await pushing;
    } catch (error) {
      // No owner can acknowledge an offline connector. An exact owner that
      // becomes stale after accepting the request rejects it explicitly.
      if (!(error instanceof RelayBrokerUnavailableError)) throw error;
    } finally {
      this.detachedPolicyPushes.delete(pushing);
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
      protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
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
      applicationDeclarationId: string;
      applicationManifestDigest: string;
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
      application_declaration_id: input.applicationDeclarationId,
      application_manifest_digest: input.applicationManifestDigest,
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
    this.closed = true;
    const sessions = [...this.connectors.values()];
    this.connectors.clear();
    for (const session of sessions) {
      session.policy.stop(new RelayUnavailableError());
      this.rejectForSocket(session.socket, new RelayUnavailableError());
      session.socket.close(1001, "Relay server closed");
    }
    await Promise.allSettled([
      ...sessions.flatMap((session) => [
        session.binding.close(),
        session.policy.waitForIdle()
      ]),
      ...this.detachedPolicyPushes
    ]);
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
      throw new ConnectorOperationError(
        reply.error.problem.code === "unknown"
          ? reply.error.problem.server_code
          : reply.error.problem.code,
        reply.error.problem.message,
        reply.error.problem,
        reply.error.details
      );
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
    if (command.kind === "policy") {
      return handlePolicyPushCommand({
        message: command.message,
        isActive: () => this.connectors.get(connectorId) === session
          && session.generation === generation
          && session.socket.readyState === 1,
        request: () => this.requestChangedPolicy(connectorId, session)
      });
    }
    if (!session.ready) {
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
    const requestId = requestIdFromMessage(command.message);
    if (!requestId) {
      return brokerError("internal", "invalid_relay_request", "The relay request did not contain a request ID.");
    }
    const expectedEncrypted = encryptedRequestFromMessage(command.message);
    const grantId = grantIdFromMessage(command.message);
    const mutationMayHaveExecuted = relayMessageMayMutate(command.message);
    const expectedType = expectedEncrypted
      ? undefined
      : expectedResponseType(command.message);
    try {
      const value = await this.sendToConnector(
        session.socket,
        connectorId,
        grantId,
        requestId,
        command.message,
        expectedEncrypted,
        expectedType,
        undefined,
        undefined,
        undefined,
        undefined,
        mutationMayHaveExecuted
      );
      return { version: 1, ok: true, value };
    } catch (error) {
      if (error instanceof RelayUnavailableError) {
        return brokerError("unavailable", "connector_offline", error.message);
      }
      if (error instanceof ConnectorOperationError) {
        return brokerProblem(error.problem, error.details);
      }
      return brokerError("internal", "relay_delivery_failed", "The relay could not deliver the request.");
    }
  }

  private sendToConnector(
    socket: WebSocket,
    connectorId: string,
    grantId: string | undefined,
    requestId: string,
    message: unknown,
    expectedEncrypted?: EncryptedRelayEnvelope,
    expectedType?: PendingRequest["expectedType"],
    expectedPolicyRevision?: string,
    expectedPolicyGeneration?: string,
    expectedPolicyMode?: PolicyMode,
    expectedPolicyInitial?: boolean,
    mutationMayHaveExecuted = false
  ): Promise<unknown> {
    if (expectedPolicyGeneration) {
      const current = this.connectors.get(connectorId);
      if (!current
          || current.socket !== socket
          || current.generation !== expectedPolicyGeneration
          || current.policy.isStopped) {
        return Promise.reject(new RelayUnavailableError());
      }
    }
    if (this.pending.has(requestId)) {
      return Promise.reject(new ConnectorOperationError(
        "duplicate_request_id",
        "The encrypted request ID is already in use."
      ));
    }
    const encoded = JSON.stringify(message);
    const requestBytes = Buffer.byteLength(encoded);
    if (grantId && !hasPendingOperationCapacity(
      this.pending.values(), connectorId, grantId, requestBytes
    )) {
      return Promise.reject(new ConnectorOperationError(
        "connector_busy",
        "The connector is processing its bounded operation queue."
      ));
    }
    const deadlineTimeout = expectedEncrypted?.deadline_unix_ms === undefined
      ? OPERATION_TIMEOUT_MS
      : expectedEncrypted.deadline_unix_ms - Date.now();
    if (deadlineTimeout <= 0) {
      return Promise.reject(ConnectorOperationError.fromProblem(normalizeConnectProblem(
        "operation_cancelled",
        "The operation deadline expired before connector execution.",
        { operation_outcome: "not_sent" }
      )));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(ConnectorOperationError.fromProblem(
          relayExecutionTimeoutProblem(expectedEncrypted, requestId)
        ));
      }, expectedType === "authorization_offer_response"
        ? OFFER_TIMEOUT_MS
        : expectedType === "policy_applied"
          ? POLICY_ACK_TIMEOUT_MS
          : Math.min(OPERATION_TIMEOUT_MS, deadlineTimeout));
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        socket,
        ...(grantId ? { connectorId, grantId, requestBytes } : {}),
        expectedEncrypted,
        expectedType,
        mutationMayHaveExecuted,
        expectedPolicyRevision,
        ...(expectedPolicyRevision ? {
          expectedPolicyConnectorId: connectorId,
          expectedPolicyGeneration,
          expectedPolicyMode,
          expectedPolicyInitial
        } : {})
      });
      try {
        socket.send(encoded, (error) => {
          if (error) this.rejectPending(requestId, new RelayUnavailableError());
        });
      } catch {
        this.rejectPending(requestId, new RelayUnavailableError());
      }
    });
  }

  private async currentGeneration(connectorId: string): Promise<string | null> {
    const result = await this.db.query<{ relay_generation: string | number }>(
      `SELECT c.relay_generation FROM connectors c
       JOIN users u ON u.id = c.user_id
       WHERE c.id = $1 AND c.revoked_at IS NULL AND u.suspended_at IS NULL`,
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

  private async requestChangedPolicy(
    connectorId: string,
    session: ConnectorSession
  ): Promise<ExactPolicyAcknowledgement> {
    const target = ++session.changedPolicyRequested;
    this.pauseForPolicyChange(session);
    try {
      const ack = await session.policy.request();
      if (this.connectors.get(connectorId) !== session) throw new RelayUnavailableError();
      session.changedPolicySettled = Math.max(session.changedPolicySettled, target);
      if (session.changedPolicySettled === session.changedPolicyRequested) {
        session.ready = true;
      }
      return ack;
    } catch (error) {
      this.closePolicyFailedSession(connectorId, session);
      throw error;
    }
  }

  private pauseForPolicyChange(session: ConnectorSession): void {
    if (!session.ready) return;
    session.ready = false;
    for (const [requestId, pending] of this.pending) {
      if (pending.socket !== session.socket || pending.expectedType === "policy_applied") continue;
      const error = pending.mutationMayHaveExecuted
        ? ConnectorOperationError.fromProblem(normalizeConnectProblem(
            "operation_outcome_unknown",
            "Policy changed after the durable mutation was sent; its outcome is unknown.",
            { operation_outcome: "unknown", details: { request_id: requestId } }
          ))
        : new RelayUnavailableError();
      this.rejectPending(requestId, error);
    }
    this.files.rejectForSocket(session.socket, new RelayUnavailableError());
  }

  private closePolicyFailedSession(connectorId: string, session: ConnectorSession): void {
    if (this.connectors.get(connectorId) !== session) return;
    this.connectors.delete(connectorId);
    session.policy.stop(new RelayUnavailableError());
    this.rejectForSocket(session.socket, new RelayUnavailableError());
    session.socket.close(4003, "Connector policy acknowledgement failed");
    void session.binding.close();
  }

  private rejectForSocket(socket: WebSocket, error: Error): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.socket === socket) this.rejectPending(requestId, error);
    }
    this.files.rejectForSocket(socket, error);
  }
}
