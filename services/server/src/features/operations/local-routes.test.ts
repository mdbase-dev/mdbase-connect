import Fastify from "fastify";
import { OPERATION_TRANSPORT_PROTOCOL_VERSION } from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import type { RelayHub } from "../../relay.js";
import { registerLocalOperationRoutes } from "./local-routes.js";

const collectionId = "11111111-1111-4111-8111-111111111111";
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe("local operation access failures", () => {
  it("returns the typed required, granted, and missing operation details", async () => {
    const app = Fastify();
    apps.push(app);
    registerErrorHandler(app);
    const db = {
      query: vi.fn(async () => ({
        rows: [{
          grant_id: "22222222-2222-4222-8222-222222222222",
          application_id: "33333333-3333-4333-8333-333333333333",
          operations: ["read", "query"],
          connector_id: "44444444-4444-4444-8444-444444444444",
          local_id: collectionId,
          encryption: null
        }],
        rowCount: 1
      }))
    } as unknown as DatabasePool;
    registerLocalOperationRoutes(app, { db, relay: {} as RelayHub });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/operations/create`,
      headers: { authorization: "Bearer token" },
      payload: {
        protocol_version: 1,
        request_id: "55555555-5555-4555-8555-555555555555",
        input: {}
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({
      code: "insufficient_access",
      message: "The application is not allowed to perform this operation.",
      details: {
        required_operations: ["create"],
        granted_operations: ["read", "query"],
        missing_operations: ["create"]
      }
    });
  });

  it("dispatches a hosted reference operation with an application replica", async () => {
    const app = Fastify();
    apps.push(app);
    registerErrorHandler(app);
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [{
            replica_id: "66666666-6666-4666-8666-666666666666",
            display_name: "Welcome to mdbase",
            operations: ["describe", "query"]
          }],
          rowCount: 1
        })
    } as unknown as DatabasePool;
    const applicationOperation = vi.fn(async () => ({
      protocol_version: 1,
      collection_id: collectionId,
      display_name: "Welcome to mdbase"
    }));
    registerLocalOperationRoutes(app, {
      db,
      relay: {} as RelayHub,
      hostedReference: { applicationOperation } as never
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/operations/describe`,
      headers: { authorization: "Bearer reference-token" },
      payload: {
        protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
        request_id: "55555555-5555-4555-8555-555555555555",
        input: {}
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.display_name).toBe("Welcome to mdbase");
    expect(applicationOperation).toHaveBeenCalledWith(
      collectionId,
      "66666666-6666-4666-8666-666666666666",
      "describe",
      {},
      {
        displayName: "Welcome to mdbase",
        operations: ["describe", "query"]
      }
    );
  });
});
