import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { DatabasePool } from "../../db.js";
import { SCOPED_HOSTED_ARCHIVE_SCHEMA, ZERO_HOSTED_ARCHIVE_SCHEMA } from "./migration-archive-profile.js";
import { registerPrearchiveMigrationRoutes } from "./migration-prearchive.js";
import { parseVerifiedBatchArchive, registerMigrationRolloutRoutes, requireFreshBatchArchive } from "./migration-rollout.js";

// Synthetic trusted-verifier DATA only, never signature/restore or production proof.
const fixture = (environment: string, scoped: boolean) => ({
  schema: scoped ? SCOPED_HOSTED_ARCHIVE_SCHEMA : ZERO_HOSTED_ARCHIVE_SCHEMA,
  environment, bucket: "synthetic-archives",
  prefix: `legacy-archive/${environment}/2026/10/20/run-123-1`, backup_id: "run-123-1",
  complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "c".repeat(40),
  migration_batch: { batch_id: "migration-one", membership_revision: "1", membership_digest: "d".repeat(64),
    membership_changed_at: "2026-10-20T00:00:00.000Z" },
  archive_created_at: "2026-10-20T01:00:00.000Z", archive_completed_at: "2026-10-20T01:00:00.000Z",
  retention: { mode: "GOVERNANCE", days: 116, retain_until: "2027-02-13T01:00:00.000Z",
    inventory_digest: "e".repeat(64), count: scoped ? "5" : "2" },
  ...(scoped ? { scoped_recovery: {
    inventory_sha256: "1".repeat(64), selection_sha256: "2".repeat(64), source_rows_sha256: "3".repeat(64),
    recovered_inventory_sha256: "4".repeat(64), original_h6_journal_sha256: "5".repeat(64),
    source_fences: [{ account_id: "01989f65-0c00-7000-8000-000000000001",
      collection_id: "01989f65-0c00-7000-8000-000000000002", migration_id: "01989f65-0c00-7000-8000-000000000003",
      started_at: "2026-10-20T00:59:00.000Z", head: 0, in_flight: 0, unresolved: 0, applied_unreceipted: 0,
      notification_watermark: '"mdbase-legacy-notifications-v1:' + "6".repeat(64) + '"',
      fence_reply_sha256: "7".repeat(64), drain_reply_sha256: "8".repeat(64) }]
  } } : {})
});

describe("managed archive and first-H6 route admission keeps dedicated authority", () => {
  it.each(["lab", "staging", "production", "local", "PRODUCTION", "unknown", ""])(
    "admits only fixed managed environments, after authentication: %s", async environment => {
      let databaseCalls = 0;
      const db = { connect: async () => { databaseCalls++; throw Error("synthetic database boundary"); } } as unknown as DatabasePool;
      const app = Fastify();
      const token = "synthetic-managed-migration-token";
      registerMigrationRolloutRoutes(app, { db, token, environment });
      registerPrearchiveMigrationRoutes(app, { db, token, environment });
      const admitted = ["lab", "staging", "production"].includes(environment);
      const url = "/internal/v1/next/migration/cohorts/migration-one/archive-binding";
      try {
        for (const view of ["capture-v1", "zero-hosted-v1"]) {
          const before = databaseCalls;
          expect((await app.inject({ url: url + "?view=" + view })).statusCode).toBe(401);
          expect(databaseCalls).toBe(before);
          const reply = await app.inject({ url: url + "?view=" + view,
            headers: { authorization: `Bearer ${token}` } });
          // Reaching this explicit fake boundary proves admission, NOT database capture.
          expect(reply.statusCode).toBe(admitted ? 500 : 503);
          expect(databaseCalls - before).toBe(admitted ? 1 : 0);
        }
        for (const kind of ["fence", "drain"]) {
          const before = databaseCalls;
          const request = { method: "POST" as const,
            url: `/internal/v1/next/migration/cohorts/migration-one/capture/collections/0/${kind}`, payload: {} };
          expect((await app.inject(request)).statusCode).toBe(401);
          const reply = await app.inject({ ...request, headers: { authorization: `Bearer ${token}` } });
          // Invalid binding never reaches DB/provider, even in production.
          expect(reply.statusCode).toBe(admitted ? 400 : 503);
          expect(databaseCalls).toBe(before);
        }
      } finally { await app.close(); }
    }
  );
});

describe("same managed migration archive profiles, never routine v4 substitution", () => {
  for (const scoped of [false, true]) {
    describe(scoped ? "scoped hosted" : "zero hosted", () => {
      it.each(["lab", "staging", "production"])("admits exact environment and legacy prefix: %s", environment => {
        const body = fixture(environment, scoped);
        const parsed = parseVerifiedBatchArchive(body);
        expect(parsed).toEqual(body);
        expect(() => requireFreshBatchArchive(parsed, body.migration_batch, body.archive_completed_at,
          body.archive_completed_at, environment)).not.toThrow();
        for (const other of ["lab", "staging", "production"].filter(value => value !== environment)) {
          expect(() => requireFreshBatchArchive(parsed, body.migration_batch, body.archive_completed_at,
            body.archive_completed_at, other)).toThrow();
          expect(() => parseVerifiedBatchArchive({ ...body,
            prefix: body.prefix.replace(`/${environment}/`, `/${other}/`) })).toThrow();
        }
      });

      it("keeps production prefix, closure and source fields closed", () => {
        const body = fixture("production", scoped);
        const invalid = [
          { ...body, environment: "PRODUCTION" }, { ...body, environment: "unknown" },
          { ...body, prefix: body.prefix.replace("legacy-archive/", "") },
          { ...body, prefix: body.prefix.replace("legacy-archive/", "routine/") },
          { ...body, source_commit: undefined }, { ...body, complete_sha256: undefined },
          { ...body, selected_hosted: [] },
          { ...body, retention: { ...body.retention, count: scoped ? "2" : "5" } },
          { ...body, retention: { ...body.retention, days: 120 } }
        ];
        if (scoped) invalid.push({ ...body, scoped_recovery: undefined });
        for (const bad of invalid) expect(() => parseVerifiedBatchArchive(bad)).toThrow();
      });

      it("retains membership and exact retention/currentness checks in production", () => {
        const body = fixture("production", scoped);
        const parsed = parseVerifiedBatchArchive(body);
        expect(() => requireFreshBatchArchive(parsed, { ...body.migration_batch, membership_revision: "2" },
          body.archive_completed_at, body.archive_completed_at, "production")).toThrow();
        expect(() => requireFreshBatchArchive(parsed, body.migration_batch, body.archive_completed_at,
          "2026-10-27T01:00:00.000Z", "production")).toThrow();
        const wrongCutoff = parseVerifiedBatchArchive({ ...body,
          retention: { ...body.retention, retain_until: "2027-02-13T01:00:00.001Z" } });
        expect(() => requireFreshBatchArchive(wrongCutoff, body.migration_batch, body.archive_completed_at,
          body.archive_completed_at, "production")).toThrow();
      });
    });
  }
});
