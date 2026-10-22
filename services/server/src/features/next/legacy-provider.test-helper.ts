// In-memory legacy provider for cutover tests: one fenced source and the
// provider's `migrating` -> `migrated` rule (drained, retention never shortened).
// Kept in a helper so importing it doesn't re-register another file's tests.
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { DatabaseQueryable } from "../../database-types.js";
import { HostedProviderResponseError, type LegacyMigrationDrain } from "../../hosted-provider.js";
import type { LegacyNotificationWatermark } from "../../hosted-provider-replies.js";
import { audit } from "../../platform/audit-events.js";
import type { LegacyRetentionProvider, TimerFlipGate } from "./migration-rollout.js";
import { TIMER_IMPORT_EVENT, type TimerSourceProvider } from "./timers/hosted-import.js";

export const TEST_TIMER_WATERMARK = `"mdbase-legacy-notifications-v1:${"0".repeat(64)}"` as LegacyNotificationWatermark;

/** The manifest an import of a timer-free source records (timers/hosted-import.ts). */
export async function recordEmptyTimerImport(db: DatabaseQueryable, account: string, source: LegacyMigrationDrain,
  watermark: string = TEST_TIMER_WATERMARK): Promise<void> {
  await audit(db, account, TIMER_IMPORT_EVENT, source.collection_id, {
    collection_id: source.collection_id, migration_id: source.migration_id, started_at: source.started_at,
    head: String(source.head), notification_watermark: watermark, timers: 0,
    identity_sha256: createHash("sha256").update("", "utf8").digest("hex"), actor: "test"
  });
}

export interface FakeLegacyProvider extends LegacyRetentionProvider, TimerSourceProvider {
  watermark: LegacyNotificationWatermark;
  source: LegacyMigrationDrain;
  calls: string[];
  /** Runs before a call's effect; throw to model a failure at that point. */
  before?: (call: "drain" | "retain") => Promise<void> | void;
}

export function fakeLegacyProvider(collection: string, overrides: Partial<LegacyMigrationDrain> = {}): FakeLegacyProvider {
  const fake: FakeLegacyProvider = {
    source: { collection_id: collection, state: "migrating", migration_id: randomUUID(), head: 42,
      started_at: "2026-10-12T00:00:00.000Z", retain_until: null, in_flight: 0, unresolved: 0, applied_unreceipted: 0,
      ...overrides },
    calls: [],
    watermark: TEST_TIMER_WATERMARK,
    async legacyMigrationSource(id) {
      fake.calls.push(`source:${id}`);
      return { drain: { ...fake.source }, notificationWatermark: fake.watermark };
    },
    async legacyMigrationDrain(id) {
      fake.calls.push(`drain:${id}`); await fake.before?.("drain");
      return { ...fake.source };
    },
    async legacyMigrationRetain(id, retainUntil) {
      fake.calls.push(`retain:${id}`); await fake.before?.("retain");
      const source = fake.source;
      if (!["migrating", "migrated"].includes(source.state) || !source.migration_id || !source.started_at) {
        throw new HostedProviderResponseError(409, "legacy_migration_transition_invalid", "Not fenced.");
      }
      if (source.in_flight !== 0) throw new HostedProviderResponseError(409, "legacy_notifications_not_drained", "Unsettled.");
      const requested = retainUntil.toISOString();
      source.state = "migrated";
      source.retain_until = source.retain_until && source.retain_until > requested ? source.retain_until : requested;
      return { collection_id: id, state: "migrated", migration_id: source.migration_id, started_at: source.started_at,
        retain_until: source.retain_until, restored: [] };
    }
  };
  return fake;
}

/** A flip gate over migrated, timer-free legacy sources whose empty timer
 * imports are recorded, for flip tests that are not about timers. */
export async function migratedTimerGate(db: DatabaseQueryable, account: string, collections: readonly string[]): Promise<TimerFlipGate> {
  const sources = new Map<string, LegacyMigrationDrain>();
  for (const collection of collections) {
    const source = fakeLegacyProvider(collection, { state: "migrated", retain_until: "2027-01-12T00:00:00.000Z" }).source;
    await recordEmptyTimerImport(db, account, source);
    sources.set(collection, source);
  }
  return { enabled: true, provider: { async legacyMigrationSource(id) {
    const source = sources.get(id);
    if (!source) throw new HostedProviderResponseError(404, "not_found", "No legacy source.");
    return { drain: { ...source }, notificationWatermark: TEST_TIMER_WATERMARK };
  } } };
}
