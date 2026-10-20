import { describe, expect, it } from "vitest";
import { parseVerifiedBatchArchive } from "./migration-rollout.js";
import { isCompleteZeroHostedInventory, ZERO_HOSTED_ARCHIVE_SCHEMA } from "./migration-archive-profile.js";

const fixture = () => ({
  schema: ZERO_HOSTED_ARCHIVE_SCHEMA, environment: "lab", bucket: "synthetic-archives",
  prefix: "legacy-archive/lab/2026/10/14/zero-one", backup_id: "zero-one",
  complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "c".repeat(40),
  migration_batch: { batch_id: "zero-cohort", membership_revision: "1", membership_digest: "d".repeat(64), membership_changed_at: "2026-10-14T00:00:00.000Z" },
  archive_created_at: "2026-10-14T01:00:00.000Z", archive_completed_at: "2026-10-14T01:00:00.000Z",
  retention: { mode: "GOVERNANCE", days: 116, retain_until: "2027-02-07T01:00:00.000Z", inventory_digest: "e".repeat(64), count: "2" }
});

describe("named zero-hosted archive metadata (not signature or live archive proof)", () => {
  it.each(["lab", "staging", "production"])("accepts exactly two actual inventory/provenance artifacts in %s", environment => {
    const body = { ...fixture(), environment, prefix: `legacy-archive/${environment}/2026/10/14/zero-one` };
    expect(parseVerifiedBatchArchive(body)).toEqual(body);
  });
  it.each(["0", "1", "3", "02", 2])("refuses an invented/empty artifact count %s", count => {
    expect(() => parseVerifiedBatchArchive({ ...fixture(), retention: { ...fixture().retention, count } })).toThrow();
  });
  it("keeps environment aliases, routine/unscoped prefixes, extra fields and absent provenance hashes closed", () => {
    for (const body of [
      { ...fixture(), environment: "PRODUCTION", prefix: "legacy-archive/production/2026/10/14/zero-one" },
      { ...fixture(), prefix: "lab/2026/10/14/zero-one" },
      { ...fixture(), prefix: "routine/lab/2026/10/14/zero-one" },
      { ...fixture(), selected_hosted: [] },
      { ...fixture(), complete_sha256: undefined },
      { ...fixture(), source_commit: undefined }
    ]) expect(() => parseVerifiedBatchArchive(body)).toThrow();
  });
  it("requires nonempty complete bounded membership with no held hosted collections", () => {
    expect(isCompleteZeroHostedInventory([["a", []], ["b", []]])).toBe(true);
    expect(isCompleteZeroHostedInventory([])).toBe(false);
    expect(isCompleteZeroHostedInventory([["a", []], ["b", ["held"]]])).toBe(false);
    expect(isCompleteZeroHostedInventory(Array.from({ length: 851 }, (_, i) => [String(i), []] as const))).toBe(false);
  });
});
