import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY,
  capabilityOperationsForContractVersion, CONNECT_CONTRACT_SUPPORT,
  CONTROL_PROTOCOL_VERSION, RELAY_CAPABILITIES, type GrantPolicy
} from "@mdbase-dev/connect-protocol";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { LocalRelayBroker, RelayBrokerUnavailableError } from "./relay-broker.js";
import { registerApplicationManifest } from "./manifest.js";
import { createTestApplicationIdentity, testApplicationAuthorization } from "./application-authorization.test-helper.js";
import { pkceChallenge, tokenHash } from "./security.js";

// Two independent hubs share only the database and broker. Only the connector
// is simulated: authentication, consent, routing and publication are real.
describe("fresh approval across relay instances (#471)", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const cleanups: Array<() => Promise<unknown>> = [];
  beforeAll(async () => { f = await fixture(cleanups); }, 30_000);
  afterAll(async () => { while (cleanups.length) await cleanups.pop()!(); });

  it.each(["portal", "connector"] as const)("publishes %s approvals received on either instance", async (source) => {
    for (const target of [f.owner, f.receiver]) {
      const request = await f.prepare(source, target);
      const response = await request.submit(target);
      expect(response.statusCode, response.body).toBe(200);
      expect((await request.state()).activated_at).not.toBeNull();
      expect(f.activations.at(-1)?.application_authorization).toEqual(request.proof);
      expect(f.activations.at(-1)?.application_origin).toBe("null");
      expect(f.owner.relay.isConnected(f.connectorId)).toBe(true);
      expect(f.receiver.relay.isConnected(f.connectorId)).toBe(false);
    }
  });

  it.each(["portal", "connector"] as const)("rejects expired %s requests without activation", async (source) => {
    const request = await f.prepare(source);
    await f.db.query("UPDATE authorization_requests SET expires_at = now() - interval '1 minute' WHERE id = $1", [request.id]);
    const before = f.activations.length;
    expect((await request.submit()).statusCode).toBe(404);
    expect(f.activations).toHaveLength(before);
    expect((await request.state()).grant_id).toBeNull();
  });

  it("revalidates consent on the owner without permitting operation escalation", async () => {
    const request = await f.prepare("portal");
    const before = f.activations.length;
    const response = await request.submit(f.receiver, { operations: [...f.operations, "delete"] });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe("invalid_grant");
    expect(f.activations).toHaveLength(before);
    expect((await request.state()).grant_id).toBeNull();
  });

  it.each(["contracts", "fresh-issuance"] as const)("reports genuine %s incompatibility separately from availability", async (fault) => {
    // A v1-only session cannot apply retained v2 grants. Retire earlier test
    // grants so this tests fresh admission, not initial policy incompatibility.
    await f.db.query("UPDATE grants SET revoked_at = now() WHERE revoked_at IS NULL");
    await f.connect(f.owner, fault);
    try {
      const request = await f.prepare("portal");
      const before = f.activations.length;
      const response = await request.submit();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("capability_contract_incompatible");
      expect(f.activations).toHaveLength(before);
      expect((await request.state()).grant_id).toBeNull();
    } finally {
      await f.connect(f.owner);
    }
  });

  it("does not activate the same request twice during concurrent approval", async () => {
    const request = await f.prepare("portal");
    const before = f.activations.length;
    f.holdActivation(true);
    const first = request.submit();
    try {
      await vi.waitFor(() => expect(f.activations).toHaveLength(before + 1));
      const second = await request.submit(f.owner);
      expect(second.statusCode, second.body).toBe(400);
      expect(second.json().error.message).toContain("already being activated");
      f.holdActivation(false);
      expect((await first).statusCode).toBe(200);
      expect(f.activations).toHaveLength(before + 1);
      expect((await request.state()).activated_at).not.toBeNull();
    } finally {
      f.holdActivation(false);
      await first;
    }
  });

  it("does not replay or compensate an approval whose committed reply was lost", async () => {
    const request = await f.prepare("portal");
    const original = f.broker.request.bind(f.broker);
    let approvalCalls = 0;
    const spy = vi.spyOn(f.broker, "request").mockImplementation(async (id, generation, command, timeout) => {
      const result = await original(id, generation, command, timeout);
      if (command.kind === "authorize") {
        approvalCalls++;
        throw new RelayBrokerUnavailableError("The relay broker request timed out.");
      }
      return result;
    });
    try {
      const response = await request.submit();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.message).toContain("Check the request status");
      expect(approvalCalls).toBe(1);
      expect((await request.state()).activated_at).not.toBeNull();
      const status = await f.receiver.app.inject({ method: "GET", url: `/v1/authorization-requests/${request.id}/status`, headers: { cookie: f.cookie } });
      expect(status.json()).toEqual({ status: "approved" });
    } finally { spy.mockRestore(); }
  });

  it("fails closed when an older owner does not recognize the approval command", async () => {
    const request = await f.prepare("portal");
    const original = f.broker.request.bind(f.broker);
    const before = f.activations.length;
    const spy = vi.spyOn(f.broker, "request").mockImplementation((id, generation, command, timeout) => command.kind === "authorize"
      ? Promise.resolve({ version: 1, ok: false, error: { kind: "internal", code: "invalid_broker_command", message: "The relay command was invalid." } })
      : original(id, generation, command, timeout));
    try {
      expect((await request.submit()).statusCode).toBe(500);
      expect(f.activations).toHaveLength(before);
      expect((await request.state()).grant_id).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it("revalidates an offer that expires after the receiving instance resolves it", async () => {
    const request = await f.prepare("portal");
    const original = f.broker.request.bind(f.broker);
    const before = f.activations.length;
    const spy = vi.spyOn(f.broker, "request").mockImplementation(async (id, generation, command, timeout) => {
      if (command.kind === "authorize") await f.db.query(
        "UPDATE authorization_collection_offers SET expires_at = now() - interval '1 minute' WHERE authorization_id = $1", [request.id]);
      return original(id, generation, command, timeout);
    });
    try {
      const response = await request.submit();
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.message).toContain("no longer being offered");
      expect(f.activations).toHaveLength(before);
      expect((await request.state()).grant_id).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it("rejects an obsolete generation before executing the owner handler", async () => {
    const request = await f.prepare("portal");
    const original = f.broker.request.bind(f.broker);
    const before = f.activations.length;
    const spy = vi.spyOn(f.broker, "request").mockImplementation(async (id, generation, command, timeout) => {
      if (command.kind === "authorize") await f.db.query("UPDATE connectors SET relay_generation = relay_generation + 1 WHERE id = $1", [id]);
      return original(id, generation, command, timeout);
    });
    try {
      const response = await request.submit();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("connector_offline");
      expect(f.activations).toHaveLength(before);
      expect((await request.state()).grant_id).toBeNull();
    } finally {
      spy.mockRestore();
      await f.connect(f.owner);
    }
  });

  it.each(["disconnect", "replacement"] as const)("does not publish a grant after %s during activation", async (fault) => {
    const request = await f.prepare("portal");
    const before = f.activations.length;
    f.holdActivation(true);
    const response = request.submit();
    try {
      await vi.waitFor(() => expect(f.activations).toHaveLength(before + 1));
      if (fault === "replacement") await f.connect(f.receiver);
      else await f.disconnect();
      const result = await response;
      expect(result.statusCode, result.body).toBe(409);
      const state = await request.state();
      expect(state.completed_at).toBeNull();
      expect(state.grant_id).toBeNull();
      expect(state.activated_at).toBeNull();
      if (fault === "replacement") {
        f.holdActivation(false);
        const next = await f.prepare("portal", f.owner);
        expect((await next.submit(f.owner)).statusCode).toBe(200);
        expect((await next.state()).activated_at).not.toBeNull();
      }
    } finally {
      f.holdActivation(false);
      await response;
      await f.connect(f.owner);
    }
  });

  it("rejects malformed internal approval commands without mutation", async () => {
    const before = (await f.db.query("SELECT id FROM grants")).rows;
    await expect(f.receiver.relay.requestAuthorization(f.connectorId, { source: "portal" })).rejects.toThrow("Invalid internal approval command");
    expect((await f.db.query("SELECT id FROM grants")).rows).toEqual(before);
  });
});

async function fixture(cleanups: Array<() => Promise<unknown>>) {
  const db = await createDatabase("memory");
  cleanups.push(() => db.end());
  const broker = new LocalRelayBroker();
  const options = { db, relayBroker: broker, devAuth: true, publicUrl: "http://connect.test" };
  const owner = await buildApp(options);
  cleanups.push(() => owner.app.close());
  const receiver = await buildApp(options);
  cleanups.push(() => receiver.app.close());
  const addresses = new Map([
    [owner, await owner.app.listen({ host: "127.0.0.1", port: 0 })],
    [receiver, await receiver.app.listen({ host: "127.0.0.1", port: 0 })]
  ]);
  const userId = randomUUID(), connectorId = randomUUID(), collectionId = randomUUID();
  const authorityId = randomUUID(), applicationId = randomUUID();
  const token = randomUUID(), email = `${userId}@example.test`;
  const operations = capabilityOperationsForContractVersion(2, "collection.read")!;
  const declaration = registerApplicationManifest({
    manifest_version: 1, id: "dev.mdbase.cross-instance-approval", name: "Cross-instance approval",
    distribution: "portable", requirements: {
      contracts: [], access: "full_collection", capabilities: { contract_version: 2, required: ["collection.read"] }
    }
  });
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')", [userId, email]);
  await db.query(`INSERT INTO connectors (id, user_id, name, token_hash, relay_public_key)
    VALUES ($1, $2, 'Computer', $3, $4)`, [connectorId, userId, tokenHash(token), createTestApplicationIdentity().publicKey]);
  await db.query(`INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version)
    VALUES ($1, $2, $3, $4, 'Local collection', '0.3.0')`, [authorityId, userId, connectorId, collectionId]);
  await db.query(`INSERT INTO applications (id, canonical_identity, family_identity, manifest_digest,
    distribution, name, homepage, redirect_uris, requirements, provisions, notifications, application_declaration)
    VALUES ($1, $2, 'bundle:dev.mdbase.cross-instance-approval', $3, 'portable', 'Cross-instance approval', '',
    '[]'::jsonb, $4::jsonb, '{"type_packs":[],"configuration":[]}'::jsonb, '{"criteria":[]}'::jsonb, $5::jsonb)`,
  [applicationId, `bundle:dev.mdbase.cross-instance-approval:sha256:${declaration.digest}`, declaration.digest,
    JSON.stringify(declaration.manifest.requirements), JSON.stringify(declaration.manifest)]);
  const login = await receiver.app.inject({ method: "POST", url: "/v1/dev/session", payload: { name: "Owner", email } });
  expect(login.statusCode, login.body).toBe(200);
  const cookies = login.headers["set-cookie"]!;
  const cookie = (Array.isArray(cookies) ? cookies[0] : cookies).split(";")[0];
  const activations: GrantPolicy[] = [];
  let hold = false;
  const held: Array<{ socket: WebSocket; respond(): void }> = [];
  let socket: WebSocket;
  async function disconnect() {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }
  cleanups.push(disconnect);
  async function connect(target: typeof owner, fault?: "contracts" | "fresh-issuance") {
    const next = new WebSocket(`${addresses.get(target)!.replace(/^http/, "ws")}/v1/relay`, {
      headers: { authorization: `Bearer ${token}` }
    });
    next.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const common = { protocol_version: CONTROL_PROTOCOL_VERSION, request_id: message.request_id };
      if (message.type === "policy_snapshot") {
        next.send(JSON.stringify({ ...common, type: "policy_applied", revision: message.revision, ok: true }));
      } else if (message.type === "authorization_offer_request") {
        next.send(JSON.stringify({ ...common, type: "authorization_offer_response", paused: false,
          collections: [{ collection_id: collectionId, display_name: "Local collection", spec_version: "0.3.0", contracts: [], types: [] }] }));
      } else if (message.type === "authorization_activation_request") {
        activations.push(message.grant);
        const respond = () => next.send(JSON.stringify({ ...common, type: "authorization_activation_response", ok: true, contracts: [], contract_setups: [] }));
        if (hold) held.push({ socket: next, respond });
        else respond();
      }
    });
    // Wait for the previous generation to retire before interpreting isConnected.
    const previous = socket;
    const replaced = previous?.readyState === WebSocket.OPEN ? once(previous, "close") : Promise.resolve();
    socket = next;
    await once(next, "open");
    next.send(JSON.stringify({ type: "relay_hello", protocol_version: CONTROL_PROTOCOL_VERSION,
      connector_version: "0.1.0-test", capabilities: RELAY_CAPABILITIES.filter((capability) => fault !== "fresh-issuance" || capability !== APPLICATION_AUTHORIZATION_V2_ISSUANCE_CAPABILITY),
      contract_support: { ...CONNECT_CONTRACT_SUPPORT, ...(fault === "contracts" ? { semantic_capabilities: [1] } : {}) } }));
    await replaced;
    await vi.waitFor(() => expect(target.relay.isConnected(connectorId)).toBe(true), { timeout: 5_000 });
  }
  await connect(owner);

  async function prepare(source: "portal" | "connector", target = receiver) {
    const id = randomUUID();
    const proof = await testApplicationAuthorization({ applicationId,
      applicationDeclarationId: "dev.mdbase.cross-instance-approval", applicationManifestDigest: declaration.digest,
      flow: "device_code", authorizationId: id, collectionId, requestedOperations: operations,
      semanticCapabilityContractVersion: 2, codeChallenge: pkceChallenge("cross-instance-approval-verifier-000000000000000") });
    await db.query(`INSERT INTO authorization_requests (id, user_id, application_id, flow, requested_operations,
      collection_id, operation_transport_protocol, application_agreement_public_key, application_signing_public_key,
      application_authorization, application_installation_id, device_origin, expires_at)
      VALUES ($1, $2, $3, 'device_code', $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10, 'null', now() + interval '10 minutes')`,
    [id, userId, applicationId, JSON.stringify(operations), collectionId, proof.binding.contracts.operation_transport,
      proof.binding.grant_agreement_public_key, proof.binding.grant_signing_public_key, JSON.stringify(proof), proof.binding.application_installation_id]);
    let offerId: string | undefined;
    if (source === "portal") {
      const discovery = await target.app.inject({ method: "GET", url: `/v1/authorization-requests/${id}`, headers: { cookie } });
      expect(discovery.statusCode, discovery.body).toBe(200);
      const selected = discovery.json().collections.find((collection: { id: string }) => collection.id === collectionId);
      expect(selected).toBeDefined();
      offerId = selected.offer_id;
    }
    return {
      id, proof,
      submit: (destination = receiver, overrides: Record<string, unknown> = {}) => destination.app.inject({ method: "POST",
        url: `/v1/${source === "connector" ? "connectors/" : ""}authorization-requests/${id}/approve`,
        headers: source === "connector" ? { authorization: `Bearer ${token}` } : { cookie },
        payload: { collection_id: collectionId, ...(offerId ? { offer_id: offerId } : {}), operations, contract_setups: [], ...overrides } }),
      state: async () => (await db.query(`SELECT ar.completed_at, ar.grant_id, g.activated_at FROM authorization_requests ar
        LEFT JOIN grants g ON g.id = ar.grant_id WHERE ar.id = $1`, [id])).rows[0]
    };
  }
  return { db, broker, owner, receiver, connectorId, cookie, operations, activations, prepare, connect, disconnect,
    holdActivation: (value: boolean) => {
      hold = value;
      if (!hold) for (const pending of held.splice(0)) {
        if (pending.socket.readyState === WebSocket.OPEN) pending.respond();
      }
    } };
}
