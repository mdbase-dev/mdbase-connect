import { once } from "node:events";
import { createECDH } from "node:crypto";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { pkceChallenge } from "./security.js";
import { testApplicationAuthorization } from "./application-authorization.test-helper.js";
import { CONNECT_CONTRACT_SUPPORT } from "@mdbase-dev/connect-protocol";

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
    let activationError: { code: string; message: string } | null = null;
    let holdActivation = true;
    let releaseActivation!: () => void;
    let activationReceived!: () => void;
    let policyObserved!: () => void;
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
          "application-authorization-v3",
          "authorization-activation",
          "encrypted-relay",
          "policy-ack"
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
          revision: message.revision,
          ok: true
        }));
      }
      if (message.type === "operation_request") {
        socket.send(JSON.stringify({
          type: "operation_response",
          protocol_version: 2,
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
    await expect(relay.route({
      connectorId: connector.connector.id,
      localCollectionId,
      requestId: "425cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed",
      grantId: "525cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed",
      applicationId,
      operation: "describe",
      operationInput: {}
    })).resolves.toEqual({ display_name: "Current notes" });

    const firstRequestId = await createAuthorizationRequest(
      app,
      applicationId,
      manifestDigest,
      cookie,
      "one"
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
    expect(approved.statusCode).toBe(200);
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
    activationError = {
      code: "access_paused",
      message: "Remote access was paused before activation."
    };
    const rejectedRequestId = await createAuthorizationRequest(
      app,
      applicationId,
      manifestDigest,
      cookie,
      "rejected"
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
      code: "access_paused"
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
        "policy-ack"
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
        required: [2],
        supported: [1],
        peer: "connector"
      },
      minimum_connector_version: "0.1.0-beta.32",
      update_url: "https://github.com/mdbase-dev/mdbase-connect/releases/latest"
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
      minimum_connector_version: "0.1.0-beta.32",
      connector_update_url: "https://github.com/mdbase-dev/mdbase-connect/releases/latest"
    });
    const overview = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(overview.json().connectors).toContainEqual(expect.objectContaining({
      id: connector.connector.id,
      connector_version: "0.1.0-beta.30",
      compatibility: "upgrade_required",
      minimum_connector_version: "0.1.0-beta.32",
      update_url: "https://github.com/mdbase-dev/mdbase-connect/releases/latest"
    }));

    const updatedSocket = new WebSocket(
      `${address.replace(/^http/, "ws")}/v1/relay`,
      { headers: { authorization: `Bearer ${connector.token}` } }
    );
    await once(updatedSocket, "open");
    const policy = once(updatedSocket, "message");
    updatedSocket.send(JSON.stringify({
      type: "relay_hello",
      protocol_version: 1,
      connector_version: "0.1.0-beta.30",
      capabilities: [
        "application-authorization-v3",
        "authorization-activation",
        "encrypted-relay",
        "policy-ack"
      ],
      contract_support: CONNECT_CONTRACT_SUPPORT
    }));
    await policy;
    const recovered = await db.query<{
      connector_version: string | null;
      incompatibility_code: string | null;
    }>(
      "SELECT connector_version, incompatibility_code FROM connectors WHERE id = $1",
      [connector.connector.id]
    );
    expect(recovered.rows[0]).toEqual({
      connector_version: "0.1.0-beta.30",
      incompatibility_code: null
    });
    updatedSocket.close();
  });
});

function p256PublicKey(): string {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return key.getPublicKey(undefined, "uncompressed").toString("base64url");
}

async function createAuthorizationRequest(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  applicationId: string,
  manifestDigest: string,
  cookie: string,
  suffix: string
): Promise<string> {
  const verifier = `live-connector-verifier-${suffix}-that-is-long-enough-000001`;
  const state = `live-${suffix}`;
  const proof = await testApplicationAuthorization({
    applicationId,
    applicationManifestDigest: manifestDigest,
    flow: "authorization_code",
    redirectUri: "http://localhost:4180/callback",
    state,
    codeChallenge: pkceChallenge(verifier),
    requestedOperations: ["describe"]
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
      operations: "describe",
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
