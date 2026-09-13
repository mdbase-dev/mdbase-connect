import type { WebSocket } from "ws";
import type { DatabasePool } from "./db.js";
import {
  RelayBrokerUnavailableError,
  type RelayBroker,
  type RelayBrokerReply
} from "./relay-broker.js";
import {
  ConnectorOperationError,
  RelayUnavailableError
} from "./relay-errors.js";
import {
  buildPolicySnapshot,
  observeConnectorPolicyStage,
  type PolicyMode,
  type PolicySnapshot
} from "./relay-policy.js";

const POLICY_RENEWAL_MS = 20_000;
const POLICY_RETRY_MS = 1_000;
const POLICY_MAX_ATTEMPTS = 3;
export const POLICY_PUSH_TIMEOUT_MS = 20_000;
export const POLICY_PUSH_SIGNAL = Object.freeze({
  type: "policy_push_request",
  protocol_version: 1
});

class StalePolicyAuthorityError extends RelayUnavailableError {}

export interface PolicySessionIdentity {
  connectorId: string;
  generation: string;
  socket: WebSocket;
}

export interface ExactPolicyAcknowledgement {
  type: "policy_applied";
  protocol_version: 1;
  request_id: string;
  revision: string;
  ok: true;
}

interface PolicyWaiter {
  target: number;
  resolve(ack: ExactPolicyAcknowledgement): void;
  reject(error: Error): void;
}

export interface PolicySessionHost {
  isActive(identity: PolicySessionIdentity): boolean;
  push(
    identity: PolicySessionIdentity,
    isStillCurrent: () => boolean,
    initial: boolean
  ): Promise<ExactPolicyAcknowledgement>;
  renewalFailed(): void;
}

export class RelayPolicySession {
  private requested = 0;
  private settled = 0;
  private running?: Promise<void>;
  private renewalTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private rejectRetry?: (error: Error) => void;
  private stopped = false;
  private acknowledged = false;
  private waiters: PolicyWaiter[] = [];

  constructor(
    readonly identity: PolicySessionIdentity,
    private readonly host: PolicySessionHost,
    private readonly mode: PolicyMode = "lease_v1"
  ) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  async start(): Promise<void> {
    await this.request();
    this.scheduleRenewal();
  }

  request(): Promise<ExactPolicyAcknowledgement> {
    if (this.stopped || !this.host.isActive(this.identity)) {
      return Promise.reject(new RelayUnavailableError());
    }
    const target = ++this.requested;
    const result = new Promise<ExactPolicyAcknowledgement>((resolve, reject) => {
      this.waiters.push({ target, resolve, reject });
    });
    if (!this.running) this.startDrain();
    return result;
  }

  stop(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.renewalTimer = undefined;
    this.retryTimer = undefined;
    this.rejectRetry?.(error);
    this.rejectRetry = undefined;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
  }

  async waitForIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private startDrain(): void {
    const running = this.drain();
    this.running = running;
    void running.finally(() => {
      if (this.running === running) this.running = undefined;
      if (!this.stopped && this.settled < this.requested && !this.running) {
        this.startDrain();
      }
    }).catch(() => undefined);
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.settled < this.requested) {
      const target = this.requested;
      let ack: ExactPolicyAcknowledgement | undefined;
      let failure: Error | undefined;
      try {
        ack = await this.pushWithRetry(!this.acknowledged);
        this.acknowledged = true;
      } catch (error) {
        failure = error instanceof Error ? error : new RelayUnavailableError();
      }
      this.settled = target;
      const settled = this.waiters.filter((waiter) => waiter.target <= target);
      this.waiters = this.waiters.filter((waiter) => waiter.target > target);
      for (const waiter of settled) {
        if (failure) waiter.reject(failure);
        else waiter.resolve(ack!);
      }
    }
  }

  private async pushWithRetry(initial: boolean): Promise<ExactPolicyAcknowledgement> {
    for (let attempt = 1; attempt <= POLICY_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.host.push(
          this.identity,
          () => !this.stopped && this.host.isActive(this.identity),
          initial
        );
      } catch (error) {
        if (error instanceof StalePolicyAuthorityError
            || this.stopped
            || !this.host.isActive(this.identity)
            || attempt === POLICY_MAX_ATTEMPTS
            || !isTransientPolicyError(error)) {
          throw error;
        }
        await this.waitForRetry();
      }
    }
    throw new RelayUnavailableError();
  }

  private waitForRetry(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new RelayUnavailableError());
        return;
      }
      this.rejectRetry = reject;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.rejectRetry = undefined;
        resolve();
      }, POLICY_RETRY_MS);
      this.retryTimer.unref();
    });
  }

  private scheduleRenewal(): void {
    if (this.mode !== "lease_v1"
        || this.stopped
        || !this.host.isActive(this.identity)) return;
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = undefined;
      void (async () => {
        try {
          await this.request();
          await this.waitForIdle();
        } catch {
          this.host.renewalFailed();
        } finally {
          this.scheduleRenewal();
        }
      })();
    }, POLICY_RENEWAL_MS);
    this.renewalTimer.unref();
  }
}

export interface ExactPolicyAuthority {
  declarationEvidence?: boolean;
  connectorId: string;
  generation: string;
  isStillCurrent(): boolean;
}

export class ExactPolicyPublisher {
  constructor(
    private readonly db: DatabasePool,
    private readonly leaseMs: number,
    private readonly currentGeneration: (connectorId: string) => Promise<string | null>,
    private readonly isOpen: () => boolean,
    private readonly mode: PolicyMode = "lease_v1"
  ) {}

  async push(
    authority: ExactPolicyAuthority,
    send: (message: PolicySnapshot) => Promise<unknown>
  ): Promise<ExactPolicyAcknowledgement> {
    if (!await observeConnectorPolicyStage("generation_before", () => this.isCurrent(authority))) {
      throw new StalePolicyAuthorityError();
    }
    const message = await observeConnectorPolicyStage("snapshot_build", () => buildPolicySnapshot(
      this.db,
      authority.connectorId,
      this.leaseMs,
      authority.generation,
      () => this.isOpen() && authority.isStillCurrent(),
      this.mode,
      authority.declarationEvidence === true
    ));
    if (!message || !await observeConnectorPolicyStage(
      "generation_after_build", () => this.isCurrent(authority)
    )) {
      throw new StalePolicyAuthorityError();
    }
    const settled = await observeConnectorPolicyStage("policy_delivery_ack", () => send(message));
    if (!await observeConnectorPolicyStage(
      "generation_after_ack", () => this.isCurrent(authority)
    )) {
      throw new StalePolicyAuthorityError();
    }
    return exactPolicyAcknowledgement(settled, message);
  }

  private async isCurrent(authority: ExactPolicyAuthority): Promise<boolean> {
    if (!this.isOpen() || !authority.isStillCurrent()) return false;
    const generation = await this.currentGeneration(authority.connectorId);
    return generation === authority.generation
      && this.isOpen()
      && authority.isStillCurrent();
  }
}

export async function requestPolicyPush(
  broker: RelayBroker,
  connectorId: string,
  generation: string
): Promise<void> {
  const reply = await broker.request(
    connectorId,
    generation,
    { version: 1, kind: "policy", message: POLICY_PUSH_SIGNAL },
    POLICY_PUSH_TIMEOUT_MS
  );
  assertPolicyPushReply(reply);
}

export async function handlePolicyPushCommand(input: {
  message: unknown;
  isActive(): boolean;
  request(): Promise<ExactPolicyAcknowledgement>;
}): Promise<RelayBrokerReply> {
  if (!isPolicyPushSignal(input.message)) {
    return relayError("internal", "invalid_policy_push", "The policy push request was invalid.");
  }
  try {
    const ack = await input.request();
    if (!input.isActive()) {
      return relayError("unavailable", "stale_policy_session", "The connector session changed.");
    }
    return { version: 1, ok: true, value: ack };
  } catch (error) {
    if (!input.isActive()) {
      return relayError("unavailable", "stale_policy_session", "The connector session changed.");
    }
    if (error instanceof RelayUnavailableError) {
      return relayError("unavailable", "connector_offline", error.message);
    }
    if (error instanceof ConnectorOperationError) {
      return {
        version: 1,
        ok: false,
        error: {
          kind: "connector",
          problem: error.problem,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      };
    }
    return relayError(
      "internal",
      "policy_delivery_failed",
      "The connector could not apply its policy."
    );
  }
}

function assertPolicyPushReply(reply: RelayBrokerReply): void {
  if (reply.ok) return;
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

function exactPolicyAcknowledgement(
  settled: unknown,
  message: PolicySnapshot
): ExactPolicyAcknowledgement {
  if (!settled || typeof settled !== "object") throw new RelayUnavailableError();
  const ack = settled as Partial<ExactPolicyAcknowledgement>;
  if (ack.type !== "policy_applied"
      || ack.protocol_version !== 1
      || ack.request_id !== message.request_id
      || ack.revision !== message.revision
      || !ack.ok) {
    throw new RelayUnavailableError();
  }
  return {
    type: "policy_applied",
    protocol_version: 1,
    request_id: ack.request_id,
    revision: ack.revision,
    ok: true
  };
}

function isPolicyPushSignal(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const signal = message as Record<string, unknown>;
  return signal.type === POLICY_PUSH_SIGNAL.type
    && signal.protocol_version === POLICY_PUSH_SIGNAL.protocol_version
    && Object.keys(signal).length === 2;
}

function isTransientPolicyError(error: unknown): boolean {
  return error instanceof RelayBrokerUnavailableError
    || error instanceof RelayUnavailableError;
}

function relayError(
  kind: "unavailable" | "internal",
  code: string,
  message: string
): RelayBrokerReply {
  return { version: 1, ok: false, error: { kind, code, message } };
}
