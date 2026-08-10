import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { ConnectorOperationError, type RelayHub } from "../../relay.js";
import { registerLocalOperationRoutes } from "./local-routes.js";

const collectionId = "11111111-1111-4111-8111-111111111111";
const oldGrantId = "22222222-2222-4222-8222-222222222221";
const activeGrantId = "22222222-2222-4222-8222-222222222222";
const applicationId = "33333333-3333-4333-8333-333333333333";
const connectorId = "44444444-4444-4444-8444-444444444444";
const authorityId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

describe("local operation access failures", () => {
  it("returns explicit overload as retryable HTTP availability", async () => {
    const { app, relay } = recoveryFixture();
    vi.mocked(relay.routeEncrypted).mockRejectedValue(new ConnectorOperationError(
      "connector_busy",
      "The connector is processing its bounded operation queue."
    ));

    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/operations/create`,
      headers: { authorization: "Bearer current-v5-token" },
      payload: encryptedEnvelope(oldGrantId, "old-key", "create")
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.json().error.code).toBe("connector_busy");
  });

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

  it("routes only an exact retired v2 mutation under a signed v5 recovery contract", async () => {
    const { app, relay } = recoveryFixture();
    const envelope = encryptedEnvelope(oldGrantId, "old-key", "create");
    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/operations/create`,
      headers: { authorization: "Bearer current-v5-token" },
      payload: envelope
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      envelope: { ...envelope, type: "encrypted_operation_response", ciphertext: "cmVzcG9uc2U" }
    });
    expect(relay.routeEncrypted).toHaveBeenCalledWith(connectorId, envelope);
  });

  it("never applies the recovery transport to a read", async () => {
    const { app, relay } = recoveryFixture();
    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/operations/read`,
      headers: { authorization: "Bearer current-v5-token" },
      payload: encryptedEnvelope(oldGrantId, "old-key", "read")
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_encrypted_envelope");
    expect(relay.routeEncrypted).not.toHaveBeenCalled();
  });

  it("rejects a newly constructed v2 mutation under the active v5 grant", async () => {
    const { app, relay } = recoveryFixture();
    const response = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/operations/create`,
      headers: { authorization: "Bearer current-v5-token" },
      payload: encryptedEnvelope(activeGrantId, "current-key", "create")
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("encryption_binding_stale");
    expect(relay.routeEncrypted).not.toHaveBeenCalled();
  });
});

function recoveryFixture() {
  const activeGrant = {
    grant_id: activeGrantId,
    user_id: "77777777-7777-4777-8777-777777777777",
    application_id: applicationId,
    application_installation_id: "88888888-8888-4888-8888-888888888888",
    collection_id: authorityId,
    operations: ["create", "read"],
    connector_id: connectorId,
    local_id: collectionId,
    encryption: {
      protocol_version: 1,
      suite: "P256-HKDF-SHA256-AES256GCM",
      key_id: "current-key",
      scope_epoch: 2,
      connector_id: connectorId,
      collection_id: collectionId,
      application_agreement_public_key: "current-application-key",
      connector_agreement_public_key: "current-connector-key"
    },
    contracts: {
      operation_transport: 3,
      operation_transport_recovery: [2],
      authorization_binding: 5,
      semantic_capabilities: 1,
      durable_mutation: 1
    }
  };
  const retiredGrant = {
    ...activeGrant,
    grant_id: oldGrantId,
    encryption: {
      ...activeGrant.encryption,
      key_id: "old-key",
      scope_epoch: 1,
      application_agreement_public_key: "old-application-key",
      connector_agreement_public_key: "old-connector-key"
    },
    contracts: {
      operation_transport: 2,
      authorization_binding: 4,
      semantic_capabilities: 1,
      durable_mutation: 1
    }
  };
  const db = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM access_tokens")) {
        return { rows: [activeGrant], rowCount: 1 };
      }
      if (sql.includes("FROM grants old")) {
        return {
          rows: values?.[0] === oldGrantId ? [retiredGrant] : [],
          rowCount: values?.[0] === oldGrantId ? 1 : 0
        };
      }
      return { rows: [], rowCount: 0 };
    })
  } as unknown as DatabasePool;
  const relay = {
    routeEncrypted: vi.fn(async (_connectorId, envelope) => ({
      ...envelope,
      type: "encrypted_operation_response",
      ciphertext: "cmVzcG9uc2U"
    }))
  } as unknown as RelayHub & { routeEncrypted: ReturnType<typeof vi.fn> };
  const app = Fastify();
  apps.push(app);
  registerErrorHandler(app);
  registerLocalOperationRoutes(app, { db, relay });
  return { app, relay };
}

function encryptedEnvelope(
  grantId: string,
  keyId: string,
  operation: "create" | "read"
) {
  return {
    type: "encrypted_operation_request" as const,
    protocol_version: 2 as const,
    suite: "P256-HKDF-SHA256-AES256GCM" as const,
    request_id: requestId,
    grant_id: grantId,
    application_id: applicationId,
    connector_id: connectorId,
    collection_id: collectionId,
    operation,
    scope_epoch: grantId === oldGrantId ? 1 : 2,
    key_id: keyId,
    counter: "7",
    ciphertext: "Y2lwaGVydGV4dA"
  };
}
