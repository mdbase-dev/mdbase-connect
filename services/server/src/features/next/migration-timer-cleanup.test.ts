import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { cleanUpRolledBackTimerImport, registerMigrationTimerCleanupRoute } from "./migration-timer-cleanup.js";

const account = "10000000-0000-4000-8000-000000000001", collection = "20000000-0000-4000-8000-000000000002";
const migration = "30000000-0000-4000-8000-000000000003";
const presented = { owner_account: account, started_us: "1000000", migration_id: migration };
type Database = Parameters<typeof cleanUpRolledBackTimerImport>[0];
type Provider = NonNullable<Parameters<typeof cleanUpRolledBackTimerImport>[1]>;

function ports(settled = true) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM hosted_collections h")) return { rows: [{ account, started_us: presented.started_us }] };
    if (sql.includes("next_migration.unfence")) return { rows: settled ? [{ present: 1 }] : [] };
    if (sql.includes("FROM next_policy_outbox") || sql.includes("metadata->'records'") || sql.includes("FROM next_timers t")) return { rows: [] };
    if (["BEGIN", "COMMIT", "ROLLBACK", "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '5s'"].includes(sql)) return { rows: [] };
    throw new Error("Unexpected test query");
  });
  const release = vi.fn(), connect = vi.fn(async () => ({ query, release }));
  const drain = vi.fn(async () => ({ collection_id: collection, state: "active", migration_id: null, started_at: null, retain_until: null }));
  return { db: { query, connect } as unknown as Database, provider: { legacyMigrationDrain: drain } as unknown as Provider,
    query, connect, release, drain };
}

describe("managed direct timer rollback-cleanup port", () => {
  it.each(["staging", "production"])("%s follows the SAME current-claim/settled-rollback transaction", async environment => {
    const p = ports();
    expect(await cleanUpRolledBackTimerImport(p.db, p.provider, environment, collection, presented))
      .toEqual({ collection_id: collection, migration_id: migration, deleted: 0 });
    expect(p.drain).toHaveBeenCalledExactlyOnceWith(collection, expect.objectContaining({ deadline: expect.any(Number) }));
    expect(p.connect).toHaveBeenCalledOnce(); expect(p.release).toHaveBeenCalledOnce();
    expect(p.query).toHaveBeenCalledWith("COMMIT");
    expect(p.query.mock.calls.filter(([sql]) => sql.includes("next_migration.unfence"))).toHaveLength(2);
  });
  it.each(["staging", "production"])("%s cannot bypass settled-rollback evidence", async environment => {
    const p = ports(false);
    await expect(cleanUpRolledBackTimerImport(p.db, p.provider, environment, collection, presented))
      .rejects.toHaveProperty("code", "migration_rollback_not_settled");
    expect(p.drain).not.toHaveBeenCalled(); expect(p.connect).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "local", "LAB", "Production", "prod", "production "])("unknown environment %j refuses before I/O", async environment => {
    const p = ports();
    await expect(cleanUpRolledBackTimerImport(p.db, p.provider, environment, collection, presented))
      .rejects.toHaveProperty("code", "migration_lab_only");
    expect(p.query).not.toHaveBeenCalled(); expect(p.drain).not.toHaveBeenCalled(); expect(p.connect).not.toHaveBeenCalled();
  });
  it.each(["staging", "production"])("%s still cannot invoke the LAB-only fixture HTTP cleanup", async environment => {
    const p = ports(), token = "t".repeat(40), app = Fastify();
    registerMigrationTimerCleanupRoute(app, { db: p.db, provider: p.provider, token, environment });
    try {
      const response = await app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${collection}/timers/rollback-cleanup`,
        headers: { authorization: `Bearer ${token}` }, payload: presented });
      expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe("migration_lab_only");
      expect(p.query).not.toHaveBeenCalled(); expect(p.drain).not.toHaveBeenCalled(); expect(p.connect).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
