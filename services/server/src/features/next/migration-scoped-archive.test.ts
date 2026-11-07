import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { legacyNotificationWatermarkSchema, type LegacyMigrationDrain } from "../../hosted-provider-replies.js";
import { requireOriginalArchiveSource } from "./migration-scoped-archive.js";

// The hosted provider's expired-prepared sweep (ADR 0005, 2026-11-07) changes
// journal counts only for collections in `active` or `migrated`. These pin why
// that cannot slip past the original-archive recheck: a `migrated -> migrating`
// rollback keeps `retain_until`, and `active -> migrating` starts a new run.
describe("original archive source after the expired-prepared sweep", () => {
  const watermark = legacyNotificationWatermarkSchema.parse(`"mdbase-legacy-notifications-v1:${"0".repeat(64)}"`);
  const collection = randomUUID(), migration = randomUUID(), started = new Date().toISOString();
  const archive = {
    complete_sha256: "a".repeat(64),
    original: {
      account_id: randomUUID(), collection_id: collection, migration_id: migration, started_at: started, head: 4,
      in_flight: 0, unresolved: 2, applied_unreceipted: 0, notification_watermark: watermark,
      fence_reply_sha256: "2".repeat(64), drain_reply_sha256: "3".repeat(64)
    }
  } as Parameters<typeof requireOriginalArchiveSource>[0];
  const source = (change: Partial<LegacyMigrationDrain> = {}): LegacyMigrationDrain => ({
    collection_id: collection, state: "migrating", migration_id: migration, started_at: started,
    retain_until: null, head: 4, in_flight: 0, unresolved: 2, applied_unreceipted: 0, ...change
  });
  const refusal = (drain: LegacyMigrationDrain) => {
    try { requireOriginalArchiveSource(archive, drain, watermark); return null; }
    catch (error) { return (error as { code?: string }).code; }
  };

  it("accepts the unchanged original source", () => {
    expect(refusal(source())).toBeNull();
  });

  it("refuses a rolled-back migrated collection whatever its swept unresolved count", () => {
    const retainUntil = new Date(Date.now() + 90 * 86400000).toISOString();
    for (const unresolved of [0, 1, 2]) {
      expect(refusal(source({ retain_until: retainUntil, unresolved }))).toBe("migration_archive_source_changed");
    }
  });

  it("refuses a later migration run of a collection swept while active", () => {
    expect(refusal(source({ migration_id: randomUUID(), unresolved: 0 }))).toBe("migration_archive_source_changed");
  });
});
