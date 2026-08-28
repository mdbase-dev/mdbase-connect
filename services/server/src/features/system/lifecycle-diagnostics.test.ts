import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import {
  LIFECYCLE_DIAGNOSTICS_SCHEMA_VERSION,
  readConnectLifecycleWork,
  registerLifecycleDiagnosticRoute
} from "./lifecycle-diagnostics.js";

const internalToken = "release-a-internal-token";

function provider() {
  return {
    authorizesInternalToken: (candidate: string | null) => candidate === internalToken
  };
}

function database(query: DatabaseConnection["query"]): DatabasePool {
  const connection = { query, release: vi.fn() };
  return {
    query,
    connect: async () => connection,
    end: async () => undefined
  };
}

describe("internal lifecycle diagnostics", () => {
  it("rejects missing and incorrect internal credentials", async () => {
    const app = Fastify();
    registerLifecycleDiagnosticRoute(app, {
      db: database(vi.fn()), hostedProvider: provider()
    });
    for (const headers of [undefined, { authorization: "Bearer wrong" }]) {
      const response = await app.inject({
        method: "GET", url: "/internal/v1/lifecycle-diagnostics", headers
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "invalid_internal_token" }
      });
    }
    await app.close();
  });

  it("contains a database failure in the typed section and keeps HTTP 200", async () => {
    const privateText = "fixture-error /private/path customer-123";
    const app = Fastify();
    registerLifecycleDiagnosticRoute(app, {
      db: database(vi.fn().mockRejectedValue(new Error(privateText))),
      hostedProvider: provider()
    });
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/lifecycle-diagnostics",
      headers: { authorization: `Bearer ${internalToken}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schema_version: LIFECYCLE_DIAGNOSTICS_SCHEMA_VERSION,
      lifecycle_work: { state: "unavailable" }
    });
    expect(response.body).not.toContain(privateText);
    await app.close();
  });

  it("returns only the fixed aggregate schema and uses one bounded read-only transaction", async () => {
    const fixtureUuid = "11111111-1111-4111-8111-111111111111";
    const fixtureError = "provider leaked /customer/path";
    const calls: string[] = [];
    const query = vi.fn(async (text: string) => {
      calls.push(text.trim());
      if (text.trimStart().startsWith("WITH cleanup_jobs")) return { rows: [{
        cleanup_open: "3", cleanup_stale: "2", cleanup_poison: "1",
        cleanup_reclaimable_sending: "1", cleanup_impossible: "2",
        cleanup_oldest_open_seconds: "901", reconciliation_due: "4",
        reconciliation_stale_due: "2", reconciliation_expired_leases: "1",
        reconciliation_missing_jobs: "1", reconciliation_retryable_results: "2",
        reconciliation_quarantined_active_grants: "1", reconciliation_impossible: "3",
        reconciliation_oldest_due_seconds: "777"
      }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
      return { rows: [], rowCount: null, command: "", oid: 0, fields: [] };
    }) as DatabaseConnection["query"];
    const value = await readConnectLifecycleWork(database(query));
    expect(value).toEqual({
      cleanup: {
        open: 3, stale: 2, poison: 1, reclaimable_sending: 1,
        impossible: 2, oldest_open_seconds: 901
      },
      application_reconciliation: {
        due: 4, stale_due: 2, expired_leases: 1, applications_missing_jobs: 1,
        retryable_results: 2, quarantined_active_grants: 1, impossible: 3,
        oldest_due_seconds: 777
      }
    });
    expect(calls.slice(0, 3)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout = '2s'",
      "SET LOCAL lock_timeout = '250ms'"
    ]);
    expect(calls.at(-1)).toBe("COMMIT");
    const serialized = JSON.stringify(value);
    for (const privateValue of [fixtureUuid, fixtureError, "/customer/path", "customer-123"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});
