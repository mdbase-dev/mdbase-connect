import { once } from "node:events";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { pkceChallenge } from "./security.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("live connector-mediated authorization", () => {
  it("offers only live local collections and activates a grant after connector acknowledgement", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
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
    let rejectActivation = false;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      relayMessages.push(message);
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
        socket.send(JSON.stringify(rejectActivation
          ? {
              type: "authorization_activation_response",
              protocol_version: 1,
              request_id: message.request_id,
              ok: false,
              contracts: [],
              error: {
                code: "access_paused",
                message: "Remote access was paused before activation."
              }
            }
          : {
              type: "authorization_activation_response",
              protocol_version: 1,
              request_id: message.request_id,
              ok: true,
              contracts: []
            }));
      }
    });
    await once(socket, "open");

    const firstRequestId = await createAuthorizationRequest(app, applicationId, cookie, "one");
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
    const approved = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${firstRequestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: serverCollectionId,
        offer_id: offer.offer_id,
        operations: ["describe"]
      }
    });
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

    rejectActivation = true;
    const rejectedRequestId = await createAuthorizationRequest(
      app,
      applicationId,
      cookie,
      "two"
    );
    const secondOffer = (await app.inject({
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
        offer_id: secondOffer.offer_id,
        operations: ["describe"]
      }
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatchObject({
      code: "access_paused",
      message: "Remote access was paused before activation."
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
});

async function createAuthorizationRequest(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  applicationId: string,
  cookie: string,
  suffix: string
): Promise<string> {
  const verifier = `live-connector-verifier-${suffix}-that-is-long-enough-000001`;
  const authorization = await app.inject({
    method: "GET",
    url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent("http://localhost:4180/callback")}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256&operations=describe`,
    headers: { cookie }
  });
  expect(authorization.statusCode).toBe(302);
  return authorization.headers.location!.split("/").at(-1)!;
}
