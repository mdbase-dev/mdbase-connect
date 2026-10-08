import { describe, expect, it } from "vitest";
import { migrationMembershipDigest, parseVerifiedBatchArchive, requireFreshBatchArchive, type ArchiveBinding } from "./migration-rollout.js";

const account = "01989f65-0c00-7000-8000-000000000001";
const account2 = "01989f65-0c00-7000-8000-000000000002";
const collection = "01989f65-0c00-7000-8000-000000000003";
const collection2 = "01989f65-0c00-7000-8000-000000000004";
const changed = "2026-10-08T00:00:00.000Z";
const created = "2026-10-08T01:00:00.000Z";
const completed = "2026-10-08T02:00:00.000Z";
const now = "2026-10-08T04:00:00.000Z";
const binding: ArchiveBinding = {
  batch_id: "production-everyone", membership_revision: "9223372036854775807",
  membership_digest: "a".repeat(64), membership_changed_at: changed
};
const fixture = () => ({
  schema: "mdbase-recovery-set/v4", environment: "production", bucket: "migration-archives",
  prefix: "production/2026/10/08/archive-one", backup_id: "archive-one",
  complete_sha256: "b".repeat(64), manifest_sha256: "c".repeat(64), source_commit: "d".repeat(40),
  migration_batch: { ...binding }, archive_created_at: created, archive_completed_at: completed,
  retention: { mode: "GOVERNANCE", days: 120,
    retain_until: new Date(Date.parse(completed) + 120 * 86_400_000).toISOString(),
    inventory_digest: "e".repeat(64), count: "18446744073709551615" }
});

describe("H0 typed ONE-verifier metadata (not archive/signature execution)", () => {
  it("agrees with the producer's Python golden membership vectors, including zero-hosted accounts", () => {
    expect(migrationMembershipDigest([])).toBe("8be7e1cdafbba150d212b74c45bfb782a1783c41850f5ab3c3d18103f4e23fc9");
    expect(migrationMembershipDigest([[account, []]])).toBe("6c80a0f7bfa230dcff6e96e7b48887eebe05cc3596e4f7822ecb25e6ea5a3cec");
    expect(migrationMembershipDigest([[account2, [collection2, collection]], [account, []]]))
      .toBe("db1d6f50140164d1a59dd805046181a75a1140528af975df0bd1d9ff67ddbf61");
  });
  it("refuses noncanonical/nil/duplicate accounts and multiply-owned hosted coverage", () => {
    for (const inventory of [
      [[account.toUpperCase(), []]], [["00000000-0000-0000-0000-000000000000", []]],
      [[account, []], [account, []]], [[account, [collection, collection]]],
      [[account, [collection]], [account2, [collection]]]
    ] as [string, string[]][][]) expect(() => migrationMembershipDigest(inventory)).toThrow();
    expect(migrationMembershipDigest([[account, []]])).not.toBe(migrationMembershipDigest([[account, [collection]]]));
  });
  it("keeps BIGINT revision and u64 count lossless, with exact current binding and cutoff", () => {
    const result = parseVerifiedBatchArchive(fixture());
    expect(result.migration_batch.membership_revision).toBe("9223372036854775807");
    expect(result.retention.count).toBe("18446744073709551615");
    expect(() => requireFreshBatchArchive(result, binding, now, now, "production")).not.toThrow();
  });
  it("refuses v3/missing/extra fields and conflicting archive identity", () => {
    for (const body of [undefined, {}, { ...fixture(), schema: "mdbase-recovery-set/v3" },
      { ...fixture(), accepted_at: now }, { ...fixture(), prefix: "staging/2026/10/08/archive-one" },
      { ...fixture(), backup_id: "archive-other" }, { ...fixture(), source_commit: "bad" }]) {
      expect(() => parseVerifiedBatchArchive(body)).toThrow();
    }
  });
  it("refuses numeric/noncanonical/overflow revisions and inventory counts", () => {
    for (const revision of [1, "0", "01", "+1", "1e3", "9223372036854775808"]) {
      expect(() => parseVerifiedBatchArchive({ ...fixture(), migration_batch: { ...binding, membership_revision: revision } })).toThrow();
    }
    for (const count of [1, "0", "01", "18446744073709551616"]) {
      expect(() => parseVerifiedBatchArchive({ ...fixture(), retention: { ...fixture().retention, count } })).toThrow();
    }
  });
  it("refuses malformed calendar/submillisecond/offset times and short or wrong retention", () => {
    for (const value of ["2026-02-30T01:00:00.000Z", "2026-10-08T01:00:00Z", "2026-10-08T01:00:00.0001Z", "2026-10-08T01:00:00.000+00:00"]) {
      expect(() => parseVerifiedBatchArchive({ ...fixture(), archive_created_at: value })).toThrow();
    }
    for (const retention of [{ ...fixture().retention, days: 119 }, { ...fixture().retention, mode: "COMPLIANCE" }]) {
      expect(() => parseVerifiedBatchArchive({ ...fixture(), retention })).toThrow();
    }
    const short = parseVerifiedBatchArchive({ ...fixture(), retention: { ...fixture().retention,
      retain_until: new Date(Date.parse(fixture().retention.retain_until) - 1).toISOString() } });
    expect(() => requireFreshBatchArchive(short, binding, now, now, "production")).toThrow();
  });
  it("never resets age through acceptance/retries and refuses future/capture-before-change evidence", () => {
    const result = parseVerifiedBatchArchive(fixture());
    const expiry = new Date(Date.parse(created) + 7 * 86_400_000).toISOString();
    expect(() => requireFreshBatchArchive(result, binding, expiry, expiry, "production")).toThrow();
    const before = new Date(Date.parse(expiry) - 1).toISOString();
    expect(() => requireFreshBatchArchive(result, binding, before, before, "production")).not.toThrow();
    expect(() => requireFreshBatchArchive(result, binding, completed, created, "production")).toThrow();
    expect(() => requireFreshBatchArchive(result, { ...binding, membership_changed_at: completed }, now, now, "production")).toThrow();
  });
  it("refuses current binding drift and missing/wrong environment", () => {
    const result = parseVerifiedBatchArchive(fixture());
    for (const current of [{ ...binding, batch_id: "other" }, { ...binding, membership_revision: "1" },
      { ...binding, membership_digest: "f".repeat(64) }]) {
      expect(() => requireFreshBatchArchive(result, current, now, now, "production")).toThrow();
    }
    for (const environment of ["", "lab", "staging"]) {
      expect(() => requireFreshBatchArchive(result, binding, now, now, environment)).toThrow();
    }
  });
});
