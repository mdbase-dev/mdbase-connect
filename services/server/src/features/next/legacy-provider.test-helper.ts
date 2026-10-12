// In-memory legacy provider for cutover tests: one fenced source and the
// provider's `migrating` -> `migrated` rule (drained, retention never shortened).
// Kept in a helper so importing it doesn't re-register another file's tests.
import { randomUUID } from "node:crypto";
import { HostedProviderResponseError, type LegacyMigrationDrain } from "../../hosted-provider.js";
import type { LegacyRetentionProvider } from "./migration-rollout.js";

export interface FakeLegacyProvider extends LegacyRetentionProvider {
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
