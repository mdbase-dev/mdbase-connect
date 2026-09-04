import { once } from "node:events";
import { createECDH, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { canonicalSha256 } from "./canonical-json.js";
import { pkceChallenge } from "./security.js";
import {
  createTestApplicationIdentity,
  testApplicationAuthorization,
  type TestApplicationIdentity
} from "./application-authorization.test-helper.js";
import {
  applicationInstallationIdFromPublicKey,
  CONNECT_CONTRACT_SUPPORT,
  type CollectionOperation,
  type OperationTransportProtocolVersion
} from "@mdbase-dev/connect-protocol";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("live connector-mediated authorization", () => {
  it("offers only live local collections and activates a grant after connector acknowledgement", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app, relay } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      allowInsecureManifests: true
    });
    resources.push(() => app.close());

    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Owner", email: "owner@example.test" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const registered = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: {
        manifest: {
          manifest_version: 1,
          id: "dev.mdbase.live-test",
          name: "Live test",
          homepage: "http://localhost:4180",
          redirect_uris: ["http://localhost:4180/callback"],
          requirements: { contracts: [], access: "full_collection" }
        }
      }
    });
    expect(registered.statusCode).toBe(200);
    const applicationId = registered.json().application.id as string;
    const manifestDigest = registered.json().application.manifest_digest as string;
    const installationIdentity = createTestApplicationIdentity();
    const connector = (await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Live computer" }
    })).json();
    const offlineConnector = (await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Offline computer" }
    })).json();
    const localCollectionId = "225cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const offlineCollectionId = "325cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const synchronized = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        relay_public_key: p256PublicKey(),
        inventory_revision: 1,
        collections: [{
          id: localCollectionId,
          display_name: "Current notes",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }]
      }
    });
    const serverCollectionId = synchronized.json().collections[0].id as string;
    const offlineSynchronized = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${offlineConnector.token}` },
      payload: {
        inventory_revision: 1,
        collections: [{
          id: offlineCollectionId,
          display_name: "Offline notes",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }]
      }
    });
    const offlineServerCollectionId =
      offlineSynchronized.json().collections[0].id as string;

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace(/^http/, "ws")}/v1/relay`,
      { headers: { authorization: `Bearer ${connector.token}` } }
    );
    resources.push(async () => {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    });
    const relayMessages: Array<Record<string, unknown>> = [];
    let activationError: { code: string; message: string; details?: unknown } | null = null;
    let holdActivation = true;
    let releaseActivation!: () => void;
    let activationReceived!: () => void;
    let policyObserved!: () => void;
    let policyAck: "exact" | "wrong_revision" = "exact";
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activationStarted = new Promise<void>((resolve) => {
      activationReceived = resolve;
    });
    const policyReady = new Promise<void>((resolve) => {
      policyObserved = resolve;
    });
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "relay_hello",
        protocol_version: 1,
        connector_version: "0.1.0-test",
        capabilities: [
          "application-authorization-v4",
          "authorization-activation",
          "encrypted-relay",
          "policy-ack",
          "policy-freshness-lease-v1"
        ],
        contract_support: CONNECT_CONTRACT_SUPPORT
      }));
    });
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      relayMessages.push(message);
      if (message.type === "policy_snapshot") {
        policyObserved();
        socket.send(JSON.stringify({
          type: "policy_applied",
          protocol_version: 1,
          request_id: message.request_id,
          revision: policyAck === "exact"
            ? message.revision
            : `sha256:${"f".repeat(64)}`,
          ok: true
        }));
      }
      if (message.type === "operation_request") {
        socket.send(JSON.stringify({
          type: "operation_response",
          protocol_version: 3,
          request_id: message.request_id,
          ok: true,
          result: { display_name: "Current notes" }
        }));
      }
      if (message.type === "authorization_offer_request") {
        socket.send(JSON.stringify({
          type: "authorization_offer_response",
          protocol_version: 1,
          request_id: message.request_id,
          paused: false,
          collections: [{
            collection_id: localCollectionId,
            display_name: "Current notes",
            spec_version: "0.3.0",
            contracts: []
          }]
        }));
      }
      if (message.type === "authorization_activation_request") {
        activationReceived();
        if (holdActivation) await activationGate;
        socket.send(JSON.stringify(activationError
          ? {
              type: "authorization_activation_response",
              protocol_version: 1,
              request_id: message.request_id,
              ok: false,
              contracts: [],
              contract_setups: [],
              error: activationError
            }
          : {
              type: "authorization_activation_response",
              protocol_version: 1,
              request_id: message.request_id,
              ok: true,
              contracts: [],
              contract_setups: message.contract_setups
            }));
      }
    });
    await once(socket, "open");
    await policyReady;
    expect(relay.isConnected(connector.connector.id)).toBe(false);
    await expect.poll(() => relay.isConnected(connector.connector.id)).toBe(true);
    await expect(relay.route({
      connectorId: connector.connector.id,
      localCollectionId,
      requestId: "425cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed",
      grantId: "525cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed",
      applicationId,
      operation: "describe",
      operationInput: {}
    })).resolves.toEqual({ display_name: "Current notes" });
    const snapshot = relayMessages.find((message) =>
      message.type === "policy_snapshot"
    )!;
    expect(Number(snapshot.lease_expires_at_ms)
      - Number(snapshot.lease_issued_at_ms)).toBe(55_000);
    await expect(relay.pushPolicy(connector.connector.id)).resolves.toBeUndefined();

    const firstRequestId = await createAuthorizationRequest(
      app,
      applicationId,
      manifestDigest,
      cookie,
      "one",
      installationIdentity
    );
    const offered = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${firstRequestId}`,
      headers: { cookie }
    });
    expect(offered.statusCode).toBe(200);
    expect(offered.json().collections).toEqual([
      expect.objectContaining({
        id: serverCollectionId,
        kind: "local",
        connector_name: "Live computer",
        display_name: "Current notes",
        offer_id: expect.any(String)
      })
    ]);
    expect(offered.json().collections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: offlineServerCollectionId })
    ]));
    expect(offered.json().unavailable_connectors).toEqual([
      {
        connector_id: offlineConnector.connector.id,
        connector_name: "Offline computer",
        reason: "offline"
      }
    ]);
    const offer = offered.json().collections[0];
    const approval = app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${firstRequestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: serverCollectionId,
        offer_id: offer.offer_id,
        operations: ["describe"]
      }
    });
    await activationStarted;
    const consented = await db.query<{
      grant_id: string | null;
      activated_at: string | null;
      completed_at: string | null;
    }>(
      `SELECT ar.grant_id, ar.completed_at, g.activated_at
       FROM authorization_requests ar JOIN grants g ON g.id = ar.grant_id
       WHERE ar.id = $1`,
      [firstRequestId]
    );
    expect(consented.rows[0].grant_id).not.toBeNull();
    expect(consented.rows[0].activated_at).toBeNull();
    expect(consented.rows[0].completed_at).toBeNull();
    const settingUp = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${firstRequestId}/status`,
      headers: { cookie }
    });
    expect(settingUp.json()).toEqual({ status: "setting_up" });
    releaseActivation();
    const approved = await approval;
    expect(approved.statusCode, JSON.stringify(approved.json())).toBe(200);
    const activation = relayMessages.find((message) =>
      message.type === "authorization_activation_request"
    );
    expect(activation).toMatchObject({
      authorization_id: firstRequestId,
      collection_id: localCollectionId,
      grant: expect.objectContaining({
        application_id: applicationId,
        collection_id: localCollectionId,
        operations: ["describe"]
      })
    });
    const active = await db.query<{
      activated_at: string | null;
      completed_at: string | null;
    }>(
      `SELECT g.activated_at, ar.completed_at
       FROM authorization_requests ar JOIN grants g ON g.id = ar.grant_id
       WHERE ar.id = $1`,
      [firstRequestId]
    );
    expect(active.rows[0].activated_at).not.toBeNull();
    expect(active.rows[0].completed_at).not.toBeNull();
    const completedStatus = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${firstRequestId}/status`,
      headers: { cookie }
    });
    expect(completedStatus.json()).toMatchObject({
      status: "approved",
      redirect_uri: expect.stringContaining("code=")
    });

    holdActivation = false;
    const replacementRequestId = await createAuthorizationRequest(
      app,
      applicationId,
      manifestDigest,
      cookie,
      "replacement",
      installationIdentity
    );
    const replacementPending = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${replacementRequestId}`,
      headers: { cookie }
    });
    expect(replacementPending.json().authorization.existing_access).toEqual([{
      collection_id: serverCollectionId,
      operations: ["describe"]
    }]);
    const replacementOffer = replacementPending.json().collections[0];
    const replacement = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${replacementRequestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: serverCollectionId,
        offer_id: replacementOffer.offer_id,
        operations: ["describe"]
      }
    });
    expect(replacement.statusCode, JSON.stringify(replacement.json())).toBe(200);
    const installationId = await applicationInstallationIdFromPublicKey(
      installationIdentity.publicKey
    );
    const replacementGrants = await db.query<{
      id: string;
      revoked_at: Date | null;
      collection_id: string;
      application_installation_id: string;
    }>(
      `SELECT id, revoked_at, collection_id, application_installation_id
       FROM grants WHERE application_id = $1
       ORDER BY created_at, id`,
      [applicationId]
    );
    expect(replacementGrants.rows).toHaveLength(2);
    const authorityCollectionId = replacementGrants.rows[0].collection_id;
    expect(replacementGrants.rows.every(({ collection_id }) =>
      collection_id === authorityCollectionId)).toBe(true);
    expect(replacementGrants.rows.every(({ application_installation_id }) =>
      application_installation_id === installationId)).toBe(true);
    expect(replacementGrants.rows.find(({ id }) => id === consented.rows[0].grant_id))
      .toEqual(expect.objectContaining({
        id: consented.rows[0].grant_id,
        revoked_at: null
      }));
    const liveReplacement = replacementGrants.rows.filter(({ revoked_at }) => !revoked_at);
    expect(liveReplacement).toHaveLength(2);

    const recoveryRequestId = await createAuthorizationRequest(
      app,
      applicationId,
      manifestDigest,
      cookie,
      "recovery",
      installationIdentity,
      ["create"],
      [2]
    );
    const recoveryOffer = (await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${recoveryRequestId}`,
      headers: { cookie }
    })).json().collections[0];
    const recovery = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${recoveryRequestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: serverCollectionId,
        offer_id: recoveryOffer.offer_id,
        operations: ["create"]
      }
    });
    expect(recovery.statusCode, JSON.stringify(recovery.json())).toBe(200);
    const afterRecovery = await db.query<{
      id: string;
      revoked_at: Date | null;
      application_authorization: {
        binding: { contracts: { operation_transport_recovery?: number[] } };
      };
    }>(
      `SELECT id, revoked_at, application_authorization
       FROM grants WHERE application_id = $1 ORDER BY created_at, id`,
      [applicationId]
    );
    expect(afterRecovery.rows).toHaveLength(3);
    const liveRecovery = afterRecovery.rows.filter(({ revoked_at }) => !revoked_at);
    expect(liveRecovery).toHaveLength(1);
    expect(liveRecovery[0].application_authorization.binding.contracts
      .operation_transport_recovery).toEqual([2]);

    const contractionRequestId = await createAuthorizationRequest(
      app,
      applicationId,
      manifestDigest,
      cookie,
      "contraction",
      installationIdentity,
      ["create"]
    );
    const contractionOffer = (await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${contractionRequestId}`,
      headers: { cookie }
    })).json().collections[0];
    const contraction = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${contractionRequestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: serverCollectionId,
        offer_id: contractionOffer.offer_id,
        operations: ["create"]
      }
    });
    expect(contraction.statusCode, JSON.stringify(contraction.json())).toBe(200);
    const afterContraction = await db.query<{
      id: string;
      revoked_at: Date | null;
      application_authorization: {
        binding: { contracts: { operation_transport_recovery?: number[] } };
      };
    }>(
      `SELECT id, revoked_at, application_authorization
       FROM grants WHERE application_id = $1 ORDER BY created_at, id`,
      [applicationId]
    );
    expect(afterContraction.rows).toHaveLength(4);
    const liveContraction = afterContraction.rows.filter(({ revoked_at }) => !revoked_at);
    expect(liveContraction).toHaveLength(1);
    expect(liveContraction[0].application_authorization.binding.contracts
      .operation_transport_recovery).toBeUndefined();
    expect(afterContraction.rows.find(({ id }) => id === liveRecovery[0].id)?.revoked_at)
      .not.toBeNull();

    activationError = {
      code: "access_paused",
      message: "Remote access was paused before activation.",
      details: {
        diagnostics: [{
          code: "schema_required",
          severity: "error",
          path: "broken.md",
          message: "Required property 'title' is missing."
        }]
      }
    };
    const rejectedRequestId = await createAuthorizationRequest(
      app,
      applicationId,
      manifestDigest,
      cookie,
      "rejected",
      installationIdentity
    );
    const rejectedOffer = (await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${rejectedRequestId}`,
      headers: { cookie }
    })).json().collections[0];
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${rejectedRequestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: serverCollectionId,
        offer_id: rejectedOffer.offer_id,
        operations: ["describe"]
      }
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatchObject({
      code: "access_paused",
      details: activationError.details
    });
    const abandoned = await db.query<{
      grant_id: string | null;
      completed_at: string | null;
    }>(
      `SELECT ar.grant_id, ar.completed_at
       FROM authorization_requests ar WHERE ar.id = $1`,
      [rejectedRequestId]
    );
    expect(abandoned.rows[0]).toMatchObject({
      grant_id: null,
      completed_at: null
    });
    const pendingGrants = await db.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM grants WHERE activated_at IS NULL"
    );
    expect(Number(pendingGrants.rows[0].count)).toBe(0);

    const degradedConnector = (await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Degraded fence computer" }
    })).json().connector;
    const fenceFailure = vi.spyOn(relay, "fenceConnector")
      .mockRejectedValueOnce(new Error("broker unavailable"));
    const degradedDeletion = await app.inject({
      method: "DELETE",
      url: `/v1/connectors/${degradedConnector.id}`,
      headers: { cookie }
    });
    expect(degradedDeletion.statusCode).toBe(200);
    expect(degradedDeletion.json()).toEqual({
      ok: true,
      committed: true,
      fence: "committed_with_degraded_fence"
    });
    const durableDeletion = await db.query<{
      revoked_at: Date | null;
      relay_generation: string | number;
    }>(
      "SELECT revoked_at, relay_generation FROM connectors WHERE id = $1",
      [degradedConnector.id]
    );
    expect(durableDeletion.rows[0]).toMatchObject({
      revoked_at: expect.any(Date),
      relay_generation: 1
    });
    const deletionAudit = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM audit_events
       WHERE subject_id = $1 AND event_type = 'connector.revoked'`,
      [degradedConnector.id]
    );
    expect(Number(deletionAudit.rows[0].count)).toBe(1);
    fenceFailure.mockRestore();

    const fenced = once(socket, "close");
    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/connectors/${connector.connector.id}`,
      headers: { cookie }
    });
    expect(removed.statusCode).toBe(200);
    await expect(fenced).resolves.toEqual(expect.arrayContaining([4003]));
    await expect(relay.route({
      connectorId: connector.connector.id,
      localCollectionId,
      requestId: randomUUID(),
      grantId: "525cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed",
      applicationId,
      operation: "describe",
      operationInput: {}
    })).rejects.toThrow();
  });

  it("rejects incompatible contract axes but accepts a package-version-only difference", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());
    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Owner", email: "upgrade@example.test" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const connector = (await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Outdated computer" }
    })).json();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(
      `${address.replace(/^http/, "ws")}/v1/relay`,
      { headers: { authorization: `Bearer ${connector.token}` } }
    );
    await once(socket, "open");
    const messagePromise = once(socket, "message");
    const closePromise = once(socket, "close");
    socket.send(JSON.stringify({
      type: "relay_hello",
      protocol_version: 1,
      connector_version: "0.1.0-beta.30",
      capabilities: [
        "application-authorization-v2",
        "authorization-activation",
        "encrypted-relay",
        "policy-ack",
        "policy-freshness-lease-v1"
      ],
      contract_support: {
        operation_transport: [1],
        authorization_binding: [2],
        semantic_capabilities: [1],
        durable_mutation: []
      }
    }));
    const [raw] = await messagePromise;
    expect(JSON.parse(raw.toString())).toMatchObject({
      type: "relay_incompatible",
      protocol_version: 1,
      code: "transport_protocol_incompatible",
      details: {
        contract: "operation_transport",
        required: [3, 2],
        supported: [1],
        peer: "connector"
      },
      minimum_connector_version: "0.1.0-beta.33",
      update_url: "https://mdbase.dev/downloads/"
    });
    const [code] = await closePromise;
    expect(code).toBe(4406);
    const recorded = await db.query<{
      connector_version: string | null;
      incompatibility_code: string | null;
      minimum_connector_version: string | null;
      connector_update_url: string | null;
    }>(
      `SELECT connector_version, incompatibility_code,
              minimum_connector_version, connector_update_url
       FROM connectors WHERE id = $1`,
      [connector.connector.id]
    );
    expect(recorded.rows[0]).toEqual({
      connector_version: "0.1.0-beta.30",
      incompatibility_code: "transport_protocol_incompatible",
      minimum_connector_version: "0.1.0-beta.33",
      connector_update_url: "https://mdbase.dev/downloads/"
    });
    const overview = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(overview.json().connectors).toContainEqual(expect.objectContaining({
      id: connector.connector.id,
      connector_version: "0.1.0-beta.30",
      compatibility: "upgrade_required",
      minimum_connector_version: "0.1.0-beta.33",
      update_url: "https://mdbase.dev/downloads/"
    }));

    const compatibleConnector = (await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Compatibility computer" }
    })).json();

    const packageVersionConnector = (await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Package-version computer" }
    })).json();
    const updatedSocket = new WebSocket(
      `${address.replace(/^http/, "ws")}/v1/relay`,
      { headers: { authorization: `Bearer ${packageVersionConnector.token}` } }
    );
    await once(updatedSocket, "open");
    const policy = waitForSocketMessage(updatedSocket, "policy_snapshot");
    updatedSocket.send(JSON.stringify({
      type: "relay_hello",
      protocol_version: 1,
      connector_version: "0.1.0-beta.55",
      capabilities: [
        "application-authorization-v4",
        "authorization-activation",
        "encrypted-relay",
        "policy-ack",
        "policy-freshness-lease-v1"
      ],
      contract_support: {
        operation_transport: [2],
        authorization_binding: [4],
        semantic_capabilities: [2],
        durable_mutation: [1]
      }
    }));
    expect((await policy).type).toBe("policy_snapshot");
    const recovered = await db.query<{
      connector_version: string | null;
      incompatibility_code: string | null;
    }>(
      "SELECT connector_version, incompatibility_code FROM connectors WHERE id = $1",
      [packageVersionConnector.connector.id]
    );
    expect(recovered.rows[0]).toEqual({
      connector_version: "0.1.0-beta.55",
      incompatibility_code: null
    });
    updatedSocket.close();
    await once(updatedSocket, "close");

    const beta56Socket = new WebSocket(
      `${address.replace(/^http/, "ws")}/v1/relay`,
      { headers: { authorization: `Bearer ${compatibleConnector.token}` } }
    );
    await once(beta56Socket, "open");
    const beta56Policy = waitForSocketMessage(beta56Socket, "policy_snapshot");
    beta56Socket.send(JSON.stringify({
      type: "relay_hello",
      protocol_version: 1,
      connector_version: "0.1.0-beta.90",
      capabilities: [
        "application-authorization-v4",
        "authorization-activation",
        "encrypted-relay",
        "policy-ack"
      ],
      contract_support: {
        operation_transport: [3],
        authorization_binding: [4],
        semantic_capabilities: [2],
        durable_mutation: [1]
      }
    }));
    const legacyPolicy = await beta56Policy;
    expect(Object.keys(legacyPolicy).sort()).toEqual([
      "grants", "protocol_version", "request_id", "revision", "type"
    ]);
    expect(legacyPolicy.revision).toBe(canonicalSha256(legacyPolicy.grants));
    beta56Socket.send(JSON.stringify({
      type: "policy_applied",
      protocol_version: 1,
      request_id: legacyPolicy.request_id,
      revision: legacyPolicy.revision,
      ok: true
    }));
    await expect.poll(async () => (await app.inject({
      method: "GET", url: "/v1/me", headers: { cookie }
    })).json().connectors.find((value: { id: string }) =>
      value.id === compatibleConnector.connector.id)?.update_recommended).toBe(true);
    const legacyOverview = (await app.inject({
      method: "GET", url: "/v1/me", headers: { cookie }
    })).json().connectors.find((value: { id: string }) =>
      value.id === compatibleConnector.connector.id);
    expect(legacyOverview).toMatchObject({
      compatibility: "compatible",
      minimum_connector_version: "0.1.0-beta.91",
      update_recommended: true
    });
    beta56Socket.close();
    await once(beta56Socket, "close");

    const beta57Socket = new WebSocket(
      `${address.replace(/^http/, "ws")}/v1/relay`,
      { headers: { authorization: `Bearer ${compatibleConnector.token}` } }
    );
    await once(beta57Socket, "open");
    const beta57Policy = waitForSocketMessage(beta57Socket, "policy_snapshot");
    beta57Socket.send(JSON.stringify({
      type: "relay_hello",
      protocol_version: 1,
      connector_version: "0.1.0-beta.57",
      capabilities: [
        "application-authorization-v4",
        "application-authorization-v5",
        "authorization-activation",
        "encrypted-relay",
        "policy-ack",
        "policy-freshness-lease-v1",
        "protocol-usage-report-v1"
      ],
      contract_support: CONNECT_CONTRACT_SUPPORT
    }));
    const leasePolicy = await beta57Policy;
    expect(leasePolicy.type).toBe("policy_snapshot");
    beta57Socket.send(JSON.stringify({
      type: "policy_applied",
      protocol_version: 1,
      request_id: leasePolicy.request_id,
      revision: leasePolicy.revision,
      ok: true
    }));
    await expect.poll(async () => (await db.query<{ adopted: Date | null }>(
      "SELECT policy_lease_adopted_at AS adopted FROM connectors WHERE id = $1",
      [compatibleConnector.connector.id]
    )).rows[0]?.adopted).not.toBeNull();
    beta57Socket.send(JSON.stringify({
      type: "protocol_usage_report",
      protocol_version: 1,
      entries: [
        { axis: "operation_transport", version: 2, count: 2 },
        { axis: "operation_transport", version: 3, count: 5 }
      ]
    }));
    await expect.poll(async () => {
      const usage = await db.query<{
        protocol_version: number;
        sample_count: number | string;
      }>(
        `SELECT protocol_version, sample_count
         FROM protocol_usage_telemetry
         WHERE surface = 'direct' ORDER BY protocol_version`
      );
      return usage.rows.map((row) => ({
        version: Number(row.protocol_version),
        count: Number(row.sample_count)
      }));
    }).toEqual([{ version: 2, count: 2 }, { version: 3, count: 5 }]);
    beta57Socket.send(JSON.stringify({
      type: "protocol_usage_report",
      protocol_version: 1,
      entries: [{ axis: "operation_transport", version: 2, count: 100 }]
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const rateLimited = await db.query<{ sample_count: number | string }>(
      `SELECT sample_count FROM protocol_usage_telemetry
       WHERE surface = 'direct' AND protocol_version = 2`
    );
    expect(Number(rateLimited.rows[0].sample_count)).toBe(2);
    beta57Socket.close();
    await once(beta57Socket, "close");

    await db.query(
      "UPDATE connectors SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = $1",
      [compatibleConnector.connector.id]
    );
    const rejectedLegacy = new WebSocket(
      `${address.replace(/^http/, "ws")}/v1/relay`,
      { headers: { authorization: `Bearer ${compatibleConnector.token}` } }
    );
    await once(rejectedLegacy, "open");
    const incompatibleMessage = once(rejectedLegacy, "message");
    const incompatibleClose = once(rejectedLegacy, "close");
    rejectedLegacy.send(JSON.stringify({
      type: "relay_hello",
      protocol_version: 1,
      connector_version: "0.1.0-beta.90",
      capabilities: [
        "application-authorization-v4",
        "authorization-activation",
        "encrypted-relay",
        "policy-ack"
      ],
      contract_support: CONNECT_CONTRACT_SUPPORT
    }));
    const [incompatibleRaw] = await incompatibleMessage;
    expect(JSON.parse(incompatibleRaw.toString())).toMatchObject({
      type: "relay_incompatible",
      code: "capability_contract_incompatible",
      minimum_connector_version: "0.1.0-beta.91"
    });
    await incompatibleClose;
    const rejectedOverview = (await app.inject({
      method: "GET", url: "/v1/me", headers: { cookie }
    })).json().connectors.find((value: { id: string }) =>
      value.id === compatibleConnector.connector.id);
    expect(rejectedOverview).toMatchObject({
      connector_version: "0.1.0-beta.90",
      compatibility: "upgrade_required",
      minimum_connector_version: "0.1.0-beta.91",
      update_recommended: false
    });
    const rejectedRow = await db.query<{
      last_seen_at: Date;
      policy_lease_adopted_at: Date | null;
    }>(
      "SELECT last_seen_at, policy_lease_adopted_at FROM connectors WHERE id = $1",
      [compatibleConnector.connector.id]
    );
    expect(new Date(rejectedRow.rows[0]!.last_seen_at).toISOString())
      .toBe("2020-01-01T00:00:00.000Z");
    expect(rejectedRow.rows[0]!.policy_lease_adopted_at).not.toBeNull();
  });
});

function p256PublicKey(): string {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return key.getPublicKey(undefined, "uncompressed").toString("base64url");
}

function waitForSocketMessage(
  socket: WebSocket,
  type: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const observed: Record<string, unknown>[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      observed.push(message);
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(
        `Socket closed before ${type}: ${code} ${reason.toString()}; observed ${JSON.stringify(observed)}.`
      ));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

async function createAuthorizationRequest(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  applicationId: string,
  manifestDigest: string,
  cookie: string,
  suffix: string,
  installationIdentity?: TestApplicationIdentity,
  requestedOperations: CollectionOperation[] = ["describe"],
  operationTransportRecovery?: OperationTransportProtocolVersion[]
): Promise<string> {
  const verifier = `live-connector-verifier-${suffix}-that-is-long-enough-000001`;
  const state = `live-${suffix}`;
  const proof = await testApplicationAuthorization({
    applicationId,
    applicationDeclarationId: "dev.mdbase.live-test",
    applicationManifestDigest: manifestDigest,
    flow: "authorization_code",
    redirectUri: "http://localhost:4180/callback",
    state,
    codeChallenge: pkceChallenge(verifier),
    requestedOperations,
    operationTransportRecovery,
    installationIdentity
  });
  const started = await app.inject({
    method: "POST",
    url: "/oauth/authorization_request",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      client_id: applicationId,
      redirect_uri: "http://localhost:4180/callback",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state,
      operations: requestedOperations.join(" "),
      application_authorization: JSON.stringify(proof)
    }).toString()
  });
  expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
  const authorizationUri = new URL(started.json().authorization_uri);
  const authorization = await app.inject({
    method: "GET",
    url: `${authorizationUri.pathname}${authorizationUri.search}`,
    headers: { cookie }
  });
  expect(authorization.statusCode).toBe(302);
  return authorization.headers.location!.split("/").at(-1)!;
}
