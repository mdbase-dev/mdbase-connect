import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { DatabasePool } from "../../db.js";

const fixture = (environment: string) => ({
  schema: "mdbase-recovery-set/zero-hosted-v1", environment, bucket: "local-archives",
  prefix: `legacy-archive/${environment}/2026/10/14/seeder-local`, backup_id: "seeder-local",
  complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "c".repeat(40),
  migration_batch: { batch_id: "rehearse-local", membership_revision: "1", membership_digest: "d".repeat(64), membership_changed_at: "2026-10-14T00:00:00.000Z" },
  archive_created_at: "2026-10-14T01:00:00.000Z", archive_completed_at: "2026-10-14T01:00:00.000Z",
  retention: { mode: "GOVERNANCE", days: 116, retain_until: "2027-02-07T01:00:00.000Z", inventory_digest: "e".repeat(64), count: "2" }
});
afterEach(() => { vi.doUnmock("../../local-build.js"); vi.unstubAllEnvs(); vi.resetModules(); });
it("managed archive parser rejects local metadata even when the runtime says local", async () => {
  vi.stubEnv("MDBASE_CONNECT_ENVIRONMENT", "local");
  const { parseVerifiedBatchArchive } = await import("./migration-rollout.js");
  expect(() => parseVerifiedBatchArchive(fixture("local"))).toThrow();
});
it("compiled local capture keeps authentication and admits only the scoped local view", async () => {
  vi.resetModules(); vi.doMock("../../local-build.js", () => ({ LOCAL_REHEARSAL_BUILD: true }));
  const { registerMigrationRolloutRoutes } = await import("./migration-rollout.js");
  let calls = 0;
  const db = { connect: async () => { calls++; throw Error("synthetic database boundary"); } } as unknown as DatabasePool;
  for (const environment of ["local", "lab", "staging", "production"]) {
    const app = Fastify(); registerMigrationRolloutRoutes(app, { db, token: "synthetic-local-token", environment });
    try {
      const url = "/internal/v1/next/migration/cohorts/rehearse-local/archive-binding";
      expect((await app.inject({ url: url + "?view=zero-hosted-v1" })).statusCode).toBe(401);
      for (const view of ["capture-v1", "zero-hosted-v1"]) {
        const before = calls;
        const reply = await app.inject({ url: url + "?view=" + view, headers: { authorization: "Bearer synthetic-local-token" } });
        const admitted = environment === "local" && view === "zero-hosted-v1";
        expect(reply.statusCode).toBe(admitted ? 500 : 503);
        expect(calls - before).toBe(admitted ? 1 : 0);
      }
    } finally { await app.close(); }
  }
});
it("only the compiled local parser admits exact local zero-hosted metadata", async () => {
  vi.resetModules(); vi.doMock("../../local-build.js", () => ({ LOCAL_REHEARSAL_BUILD: true }));
  const { parseVerifiedBatchArchive, requireFreshBatchArchive } = await import("./migration-rollout.js");
  const local = fixture("local");
  expect(parseVerifiedBatchArchive(local)).toEqual(local);
  expect(() => requireFreshBatchArchive(parseVerifiedBatchArchive(local), local.migration_batch,
    "2026-10-14T01:00:01.000Z", "2026-10-14T01:00:01.000Z", "local")).not.toThrow();
  for (const environment of ["lab", "staging", "production"]) expect(() => parseVerifiedBatchArchive(fixture(environment))).toThrow();
  for (const patch of [{ prefix: local.prefix.replace("local", "lab") }, { schema: "mdbase-recovery-set/v4" },
    { retention: { ...local.retention, count: "0" } }, { invented: true }]) expect(() => parseVerifiedBatchArchive({ ...local, ...patch })).toThrow();
});
