import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CONNECT_CONTRACT_SUPPORT } from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDatabase } from "./db.js";
import type { DatabasePool } from "./database-types.js";
import { RelayHub } from "./relay.js";
import { LocalRelayBroker } from "./relay-broker.js";
import { POLICY_PUSH_SIGNAL, POLICY_PUSH_TIMEOUT_MS } from "./relay-policy-session.js";
import type { PolicySnapshot } from "./relay-policy.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class PolicySocket extends EventEmitter {
  readyState = 1;
  readonly policies: PolicySnapshot[] = [];
  readonly messages: Array<Record<string, unknown>> = [];
  readonly held: PolicySnapshot[] = [];
  hold = false;
  inFlight = 0;
  maxInFlight = 0;

  send(raw: string, callback?: (error?: Error) => void): void {
    callback?.();
    const message = JSON.parse(raw) as PolicySnapshot;
    this.messages.push(message as unknown as Record<string, unknown>);
    if (message.type !== "policy_snapshot") return;
    this.policies.push(message);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.hold) this.held.push(message);
    else queueMicrotask(() => this.ack(message));
  }

  ack(message = this.held.shift()): void {
    if (!message) throw new Error("No held policy to acknowledge.");
    this.inFlight -= 1;
    this.emit("message", Buffer.from(JSON.stringify({
      type: "policy_applied",
      protocol_version: 1,
      request_id: message.request_id,
      revision: message.revision,
      ok: true
    })), false);
  }

  reject(message = this.held.shift()): void {
    if (!message) throw new Error("No held policy to reject.");
    this.inFlight -= 1;
    this.emit("message", Buffer.from(JSON.stringify({
      type: "policy_applied",
      protocol_version: 1,
      request_id: message.request_id,
      revision: message.revision,
      ok: false,
      error: { code: "policy_apply_failed", message: "rejected" }
    })), false);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

const databases: DatabasePool[] = [];
const relays: RelayHub[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(databases.splice(0).map((db) => db.end()));
});

async function fixture(dbOverride?: (db: DatabasePool) => DatabasePool): Promise<{
  db: DatabasePool;
  relay: RelayHub;
  connectorId: string;
}> {
  const db = await createDatabase("memory");
  databases.push(db);
  const userId = randomUUID();
  const connectorId = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, 'Renewal')",
    [userId, `${userId}@example.test`]
  );
  await db.query(
    `INSERT INTO connectors (id, user_id, name, token_hash)
     VALUES ($1, $2, 'Laptop', 'renewal-hash')`,
    [connectorId, userId]
  );
  const relay = new RelayHub(dbOverride?.(db) ?? db);
  relays.push(relay);
  return { db, relay, connectorId };
}

async function twoHubFixture(): Promise<{
  db: DatabasePool;
  broker: LocalRelayBroker;
  owner: RelayHub;
  remote: RelayHub;
  connectorId: string;
}> {
  const db = await createDatabase("memory");
  databases.push(db);
  const userId = randomUUID();
  const connectorId = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, $2, 'Two hubs')",
    [userId, `${userId}@example.test`]
  );
  await db.query(
    `INSERT INTO connectors (id, user_id, name, token_hash)
     VALUES ($1, $2, 'Laptop', 'two-hub-hash')`,
    [connectorId, userId]
  );
  const broker = new LocalRelayBroker();
  const owner = new RelayHub(db, broker);
  const remote = new RelayHub(db, broker);
  relays.push(owner, remote);
  return { db, broker, owner, remote, connectorId };
}

function delayOneConnect(db: DatabasePool): {
  db: DatabasePool;
  started: Promise<void>;
  release(): void;
} {
  const started = deferred<void>();
  const release = deferred<void>();
  let delayed = false;
  const wrapped = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "connect") {
        return async () => {
          if (!delayed) {
            delayed = true;
            started.resolve();
            await release.promise;
          }
          return target.connect();
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { db: wrapped, started: started.promise, release: () => release.resolve() };
}

function legacyHello() {
  return Promise.resolve({
    protocol_version: 1 as const,
    connector_version: "0.1.0-beta.90",
    capabilities: [
      "application-authorization-v4",
      "authorization-activation",
      "encrypted-relay",
      "policy-ack"
    ],
    contract_support: CONNECT_CONTRACT_SUPPORT
  });
}

function hello() {
  return Promise.resolve({
    protocol_version: 1 as const,
    connector_version: "0.1.0-test",
    capabilities: [
      "application-authorization-v4",
      "authorization-activation",
      "encrypted-relay",
      "policy-ack",
      "policy-freshness-lease-v1"
    ],
    contract_support: CONNECT_CONTRACT_SUPPORT
  });
}

async function attach(relay: RelayHub, connectorId: string, socket: PolicySocket): Promise<void> {
  await relay.attach(connectorId, socket as unknown as WebSocket, hello());
}

async function sequence(db: DatabasePool, connectorId: string): Promise<number> {
  const result = await db.query<{ policy_sequence: string | number }>(
    "SELECT policy_sequence FROM connectors WHERE id = $1",
    [connectorId]
  );
  return Number(result.rows[0]!.policy_sequence);
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}

async function settleAsync(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("exact-session policy renewal scheduler", () => {
  it("does not let a requested push overtake a delayed initial build", async () => {
    const base = await createDatabase("memory");
    databases.push(base);
    const delayed = delayOneConnect(base);
    const userId = randomUUID();
    const connectorId = randomUUID();
    await base.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')", [
      userId, `${userId}@example.test`
    ]);
    await base.query(
      "INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, 'Laptop', 'hash')",
      [connectorId, userId]
    );
    const relay = new RelayHub(delayed.db);
    relays.push(relay);
    const socket = new PolicySocket();
    const attaching = relay.attach(connectorId, socket as unknown as WebSocket, hello());
    await delayed.started;
    const eventPush = relay.pushPolicy(connectorId);
    expect(socket.policies).toHaveLength(0);
    expect(await sequence(base, connectorId)).toBe(0);
    delayed.release();
    await Promise.all([attaching, eventPush]);
    expect(socket.policies.map((policy) => policy.sequence)).toEqual([1, 2]);
    expect(socket.maxInFlight).toBe(1);
  });

  it("keeps timer and grant-event pushes single-flight and coalesces queued changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { relay, connectorId } = await fixture();
    const socket = new PolicySocket();
    await attach(relay, connectorId, socket);
    socket.hold = true;
    vi.advanceTimersByTime(20_000);
    await eventually(() => expect(socket.held).toHaveLength(1));
    const pushes = [
      relay.pushPolicy(connectorId),
      relay.pushPolicy(connectorId),
      relay.pushPolicy(connectorId)
    ];
    expect(socket.held).toHaveLength(1);
    socket.ack();
    await eventually(() => expect(socket.held).toHaveLength(1));
    socket.ack();
    await Promise.all(pushes);
    expect(socket.policies).toHaveLength(3);
    expect(socket.maxInFlight).toBe(1);
    expect(socket.policies.map((policy) => policy.sequence)).toEqual([1, 2, 3]);
  });

  it("coalesces remote grant events with the owner renewal and returns its exact ack", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { broker, owner, remote, connectorId } = await twoHubFixture();
    const socket = new PolicySocket();
    await attach(owner, connectorId, socket);
    socket.hold = true;

    vi.advanceTimersByTime(20_000);
    await eventually(() => expect(socket.held).toHaveLength(1));
    const remotePushes = [
      remote.pushPolicy(connectorId),
      remote.pushPolicy(connectorId),
      remote.pushPolicy(connectorId)
    ];
    const exactReply = broker.request(
      connectorId,
      "1",
      { version: 1, kind: "policy", message: POLICY_PUSH_SIGNAL },
      POLICY_PUSH_TIMEOUT_MS
    );
    expect(socket.held).toHaveLength(1);
    socket.ack();
    await eventually(() => expect(socket.held).toHaveLength(1));
    const newest = socket.held[0]!;
    socket.ack();

    const reply = await exactReply;
    await Promise.all(remotePushes);
    expect(reply).toEqual({
      version: 1,
      ok: true,
      value: {
        type: "policy_applied",
        protocol_version: 1,
        request_id: newest.request_id,
        revision: newest.revision,
        ok: true
      }
    });
    expect(socket.policies.map((policy) => policy.sequence)).toEqual([1, 2, 3]);
    expect(socket.maxInFlight).toBe(1);
  });

  it("keeps readiness fenced across interleaved local and broker pushes and closes on final failure", async () => {
    const { owner, remote, connectorId } = await twoHubFixture();
    const socket = new PolicySocket();
    await attach(owner, connectorId, socket);
    socket.hold = true;

    const local = owner.pushPolicy(connectorId);
    await eventually(() => expect(socket.held).toHaveLength(1));
    const brokerPush = remote.pushPolicy(connectorId);
    expect(owner.isConnected(connectorId)).toBe(false);
    socket.ack();
    await local;
    expect(owner.isConnected(connectorId)).toBe(false);
    await eventually(() => expect(socket.held).toHaveLength(1));
    socket.reject();

    await expect(brokerPush).rejects.toBeInstanceOf(Error);
    await eventually(() => expect(socket.readyState).toBe(3));
    expect(owner.isConnected(connectorId)).toBe(false);
  });

  it("classifies plaintext mutations as outcome unknown when policy fencing suppresses them", async () => {
    const { relay, connectorId } = await fixture();
    const socket = new PolicySocket();
    await attach(relay, connectorId, socket);
    const mutation = relay.route({
      connectorId,
      localCollectionId: randomUUID(),
      requestId: randomUUID(),
      grantId: randomUUID(),
      applicationId: randomUUID(),
      operation: "create",
      operationInput: { type: "note", value: {} }
    });
    await eventually(() => expect(socket.messages.some((message) =>
      message.type === "operation_request")).toBe(true));
    socket.hold = true;
    const push = relay.pushPolicy(connectorId);
    await expect(mutation).rejects.toMatchObject({
      code: "operation_outcome_unknown",
      problem: { operation_outcome: "unknown" }
    });
    await eventually(() => expect(socket.held).toHaveLength(1));
    socket.ack();
    await push;
  });

  it("returns generic unavailable for a fenced plaintext read", async () => {
    const { relay, connectorId } = await fixture();
    const socket = new PolicySocket();
    await attach(relay, connectorId, socket);
    const read = relay.route({
      connectorId,
      localCollectionId: randomUUID(),
      requestId: randomUUID(),
      grantId: randomUUID(),
      applicationId: randomUUID(),
      operation: "query",
      operationInput: {}
    });
    await eventually(() => expect(socket.messages.some((message) =>
      message.type === "operation_request")).toBe(true));
    socket.hold = true;
    const push = relay.pushPolicy(connectorId);
    await expect(read).rejects.toBeInstanceOf(Error);
    await expect(read).rejects.not.toMatchObject({ code: "operation_outcome_unknown" });
    await eventually(() => expect(socket.held).toHaveLength(1));
    socket.ack();
    await push;
  });

  it("does not periodically renew legacy policy but still sends event snapshots", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { relay, connectorId } = await fixture();
    const socket = new PolicySocket();
    await relay.attach(connectorId, socket as unknown as WebSocket, legacyHello());
    expect(socket.policies).toHaveLength(1);
    vi.advanceTimersByTime(120_000);
    await settleAsync();
    expect(socket.policies).toHaveLength(1);
    await relay.pushPolicy(connectorId);
    expect(socket.policies).toHaveLength(2);
  });

  it("durably rejects a legacy attach between lease negotiation and acknowledgement", async () => {
    const { db, owner, remote, connectorId } = await twoHubFixture();
    const leaseSocket = new PolicySocket();
    leaseSocket.hold = true;
    const leaseAttach = owner.attach(
      connectorId,
      leaseSocket as unknown as WebSocket,
      hello()
    );
    await eventually(() => expect(leaseSocket.held).toHaveLength(1));

    const negotiated = await db.query<{
      relay_generation: string | number;
      policy_lease_negotiated_at: Date | null;
      policy_lease_adopted_at: Date | null;
    }>(
      `SELECT relay_generation, policy_lease_negotiated_at, policy_lease_adopted_at
       FROM connectors WHERE id = $1`,
      [connectorId]
    );
    expect(Number(negotiated.rows[0]!.relay_generation)).toBe(1);
    expect(negotiated.rows[0]!.policy_lease_negotiated_at).not.toBeNull();
    expect(negotiated.rows[0]!.policy_lease_adopted_at).toBeNull();

    const legacySocket = new PolicySocket();
    await remote.attach(
      connectorId,
      legacySocket as unknown as WebSocket,
      legacyHello()
    );
    expect(legacySocket.readyState).toBe(3);
    expect(legacySocket.policies).toHaveLength(0);

    const rejected = await db.query<{
      relay_generation: string | number;
      policy_lease_negotiated_at: Date | null;
      policy_lease_adopted_at: Date | null;
      latest_policy_mode: string | null;
    }>(
      `SELECT relay_generation, policy_lease_negotiated_at,
              policy_lease_adopted_at, latest_policy_mode
       FROM connectors WHERE id = $1`,
      [connectorId]
    );
    expect(Number(rejected.rows[0]!.relay_generation)).toBe(1);
    expect(rejected.rows[0]!.policy_lease_negotiated_at).not.toBeNull();
    expect(rejected.rows[0]!.policy_lease_adopted_at).toBeNull();
    expect(rejected.rows[0]!.latest_policy_mode).toBe("lease_v1");

    leaseSocket.ack();
    await leaseAttach;
    const adopted = await db.query<{
      policy_lease_negotiated_at: Date | null;
      policy_lease_adopted_at: Date | null;
    }>(
      `SELECT policy_lease_negotiated_at, policy_lease_adopted_at
       FROM connectors WHERE id = $1`,
      [connectorId]
    );
    expect(adopted.rows[0]!.policy_lease_negotiated_at).not.toBeNull();
    expect(adopted.rows[0]!.policy_lease_adopted_at).not.toBeNull();
  });

  it("rejects a remote request accepted by an owner that is then replaced", async () => {
    const { db, broker, owner, remote, connectorId } = await twoHubFixture();
    const oldSocket = new PolicySocket();
    await attach(owner, connectorId, oldSocket);
    oldSocket.hold = true;
    const remoteRejected = expect(remote.pushPolicy(connectorId)).rejects.toBeInstanceOf(Error);
    await eventually(() => expect(oldSocket.held).toHaveLength(1));

    const successor = new RelayHub(db, broker);
    relays.push(successor);
    const successorSocket = new PolicySocket();
    await attach(successor, connectorId, successorSocket);

    await remoteRejected;
    expect(oldSocket.policies).toHaveLength(2);
    expect(successorSocket.policies).toHaveLength(1);
    expect(successorSocket.policies[0]!.sequence).toBe(3);
  });

  it("cancels an in-flight remote push when the socket-owning hub closes", async () => {
    const { owner, remote, connectorId } = await twoHubFixture();
    const socket = new PolicySocket();
    await attach(owner, connectorId, socket);
    socket.hold = true;
    const remoteRejected = expect(remote.pushPolicy(connectorId)).rejects.toBeInstanceOf(Error);
    await eventually(() => expect(socket.held).toHaveLength(1));

    await owner.close();
    await remoteRejected;
    expect(socket.policies).toHaveLength(2);
    expect(socket.maxInFlight).toBe(1);
  });

  it("cannot complete policies in reverse order", async () => {
    const { relay, connectorId } = await fixture();
    const socket = new PolicySocket();
    await attach(relay, connectorId, socket);
    socket.hold = true;
    const first = relay.pushPolicy(connectorId);
    await vi.waitFor(() => expect(socket.held).toHaveLength(1));
    const second = relay.pushPolicy(connectorId);
    expect(socket.held).toHaveLength(1);
    socket.ack();
    await eventually(() => expect(socket.held).toHaveLength(1));
    socket.ack();
    await Promise.all([first, second]);
    expect(socket.policies.map((policy) => policy.sequence)).toEqual([1, 2, 3]);
    expect(socket.maxInFlight).toBe(1);
  });

  it("does not send or increment for an old session replaced during build", async () => {
    const base = await createDatabase("memory");
    databases.push(base);
    const userId = randomUUID();
    const connectorId = randomUUID();
    await base.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')", [
      userId, `${userId}@example.test`
    ]);
    await base.query(
      "INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, 'Laptop', 'hash')",
      [connectorId, userId]
    );
    const firstRelay = new RelayHub(base);
    relays.push(firstRelay);
    const firstSocket = new PolicySocket();
    await attach(firstRelay, connectorId, firstSocket);

    const delayed = delayOneConnect(base);
    const staleRelay = new RelayHub(delayed.db);
    relays.push(staleRelay);
    const staleSocket = new PolicySocket();
    const staleAttach = staleRelay.attach(connectorId, staleSocket as unknown as WebSocket, hello());
    await delayed.started;

    const successorRelay = new RelayHub(base);
    relays.push(successorRelay);
    const successorSocket = new PolicySocket();
    await attach(successorRelay, connectorId, successorSocket);
    const beforeRelease = await sequence(base, connectorId);
    delayed.release();
    await expect(staleAttach).rejects.toBeInstanceOf(Error);
    expect(await sequence(base, connectorId)).toBe(beforeRelease);
    expect(staleSocket.policies).toHaveLength(0);
    expect(successorSocket.policies).toHaveLength(1);
  });

  it("close drains an in-flight build and leaves no timer or sequence changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const base = await createDatabase("memory");
    databases.push(base);
    const delayed = delayOneConnect(base);
    const userId = randomUUID();
    const connectorId = randomUUID();
    await base.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')", [
      userId, `${userId}@example.test`
    ]);
    await base.query(
      "INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, 'Laptop', 'hash')",
      [connectorId, userId]
    );
    const relay = new RelayHub(base);
    relays.push(relay);
    const socket = new PolicySocket();
    await attach(relay, connectorId, socket);
    const before = await sequence(base, connectorId);

    const renewalRelay = new RelayHub(delayed.db);
    relays.push(renewalRelay);
    const renewalSocket = new PolicySocket();
    const attaching = renewalRelay.attach(
      connectorId,
      renewalSocket as unknown as WebSocket,
      hello()
    );
    await delayed.started;
    const closing = renewalRelay.close();
    delayed.release();
    await expect(attaching).rejects.toBeInstanceOf(Error);
    await closing;
    const afterClose = await sequence(base, connectorId);
    vi.advanceTimersByTime(120_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await sequence(base, connectorId)).toBe(afterClose);
    expect(afterClose).toBe(before);
    expect(renewalSocket.policies).toHaveLength(0);
  });

  it("acknowledges renewals for more than sixty seconds of logical time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { relay, connectorId } = await fixture();
    const socket = new PolicySocket();
    await attach(relay, connectorId, socket);
    for (let expected = 2; expected <= 4; expected += 1) {
      vi.advanceTimersByTime(20_000);
      await eventually(() => expect(socket.policies.length).toBe(expected));
      await settleAsync();
    }
    expect(socket.policies.length).toBeGreaterThanOrEqual(4);
    expect(socket.policies.every((policy) =>
      policy.lease_expires_at_ms - policy.lease_issued_at_ms === 55_000
    )).toBe(true);
    expect(socket.maxInFlight).toBe(1);
  });
});
