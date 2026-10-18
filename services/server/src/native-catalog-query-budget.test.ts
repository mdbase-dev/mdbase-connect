import { describe, expect, it, vi } from "vitest";
import { listNativeCollectionsVisibleToUser } from "./collection-catalog.js";

const owner = "10000000-0000-4000-8000-000000000001";
function inventory(size: number) {
  const rows = Array.from({ length: size }, (_, index) => ({
    collection_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    owner_user_id: owner, display_name: `Collection ${index + 1}`,
    runtime: "next", sync: "cloud_copy", left_sync_at: null, created_at: new Date("2026-01-01T00:00:00Z"),
  }));
  const query = vi.fn().mockImplementation(async (sql: string, values: unknown[]) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM next_collections native")) return { rows };
    if (normalized.includes("FROM next_collections WHERE collection_id = $1"))
      return { rows: rows.filter(row => row.collection_id === values[0]) };
    if (normalized.startsWith("SELECT id FROM users")) return { rows: [{ id: owner }] };
    if (normalized.includes("FROM next_collection_deletion_facts")) return { rows: [] };
    if (normalized.includes("FROM next_migration_cohort_members")) return { rows: [] };
    throw new Error(`Unexpected synthetic inventory query: ${normalized}`);
  });
  return { rows, db: { query } };
}

describe("native management catalog query budget", () => {
  it.each([1, 80])("projects %i owned Cloud Copy collections with set-based reads", async size => {
    const fixture = inventory(size);
    const visible = await listNativeCollectionsVisibleToUser(fixture.db, owner);
    expect(visible).toHaveLength(size);
    expect(visible.every(row => row.access.relationship === "owner" && row.access.can_manage_members)).toBe(true);
    // Collection metadata/authority and the account freeze projection must not
    // execute another query per collection as the inventory grows.
    expect(fixture.db.query.mock.calls.length).toBeLessThanOrEqual(1);
    expect(fixture.db.query.mock.calls.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
  });
});
