import { describe, expect, it } from "vitest";
import { parseVerifiedBatchArchive, requireFreshBatchArchive } from "./migration-rollout.js";

const changed = "2026-10-08T00:00:00.000Z", created = "2026-10-08T01:00:00.000Z";
const completed = "2026-10-08T02:00:00.000Z", now = "2026-10-08T04:00:00.000Z";
const binding = { batch_id: "synthetic-lab", membership_revision: "1", membership_digest: "a".repeat(64), membership_changed_at: changed };
const component = (name: string, commit: string) => ({ commit: commit.repeat(40), image_digest: `sha256:${commit.repeat(64)}`, service_id: `srv-synthetic${name}` });
const fixture = () => ({
  schema: "mdbase-recovery-set/lab-cohort-v1", environment: "lab", bucket: "synthetic-archives",
  prefix: "legacy-archive/lab/2026/10/08/synthetic-one", backup_id: "synthetic-one",
  complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "f".repeat(40),
  migration_batch: { ...binding }, archive_created_at: created, archive_completed_at: completed,
  retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(completed) + 116 * 86_400_000).toISOString(),
    inventory_digest: "c".repeat(64), count: "1" },
  runtime_provenance: { connect: component("connect", "a"), hosted_provider: component("provider", "b"),
    relay: component("relay", "c"), mcp: component("mcp", "d") }
});

describe("explicit LAB cohort archive DATA, not signature/source-exclusion/native authority", () => {
  it("preserves honest mixed component provenance separately from Ops capture/signing commit", () => {
    const body = fixture(); const original = JSON.stringify(body);
    const result = parseVerifiedBatchArchive(body);
    expect(result).toEqual(body); expect(JSON.stringify(body)).toBe(original);
    expect(() => requireFreshBatchArchive(result, binding, now, now, "lab")).not.toThrow();
  });
  it.each([
    { schema: "mdbase-recovery-set/v3" }, { schema: "mdbase-recovery-set/v4" },
    { environment: "production" }, { environment: "staging" }, { environment: "LAB" },
    { prefix: "lab/2026/10/08/synthetic-one" }, { prefix: "routine/lab/2026/10/08/synthetic-one" },
    { prefix: "legacy-archive/production/2026/10/08/synthetic-one" },
    { prefix: "legacy-archive/lab/2026/10/08/other" }, { verified: true },
    { source_commit: "guess-common-release" }, { runtime_provenance: undefined },
    { runtime_provenance: { ...fixture().runtime_provenance, extra: component("extra", "e") } }
  ])("refuses wrong profile/environment/prefix, missing topology or caller flags (%j)", delta => {
    expect(() => parseVerifiedBatchArchive({ ...fixture(), ...delta })).toThrow();
  });
  it.each(["connect", "hosted_provider", "relay", "mcp"] as const)("requires exact %s shape", name => {
    for (const value of [undefined, {}, { ...component(name, "a"), extra: true },
      { ...component(name, "a"), commit: "a".repeat(39) },
      { ...component(name, "a"), image_digest: "a".repeat(64) },
      { ...component(name, "a"), image_digest: `sha256:${"A".repeat(64)}` },
      { ...component(name, "a"), service_id: "srv-fixture\n" }]) {
      expect(() => parseVerifiedBatchArchive({ ...fixture(), runtime_provenance: {
        ...fixture().runtime_provenance, [name]: value
      } })).toThrow();
    }
  });
  it("matches the bounded opaque service-ID grammar without importing private infrastructure mapping", () => {
    const body = fixture(); body.runtime_provenance.connect.service_id = `srv-${"a".repeat(80)}`;
    expect(parseVerifiedBatchArchive(body)).toEqual(body);
    body.runtime_provenance.connect.service_id += "a";
    expect(() => parseVerifiedBatchArchive(body)).toThrow();
  });
  it.each([
    { ...binding, membership_revision: "2" }, { ...binding, membership_digest: "d".repeat(64) },
    { ...binding, batch_id: "other" }, { ...binding, membership_changed_at: now }
  ])("retains exact current frozen membership binding (%j)", current => {
    expect(() => requireFreshBatchArchive(parseVerifiedBatchArchive(fixture()), current, now, now, "lab")).toThrow();
  });
  it("does not renew archive age or admit incorrect retention/capture ordering", () => {
    const result = parseVerifiedBatchArchive(fixture());
    expect(() => requireFreshBatchArchive(result, binding, now, new Date(Date.parse(created) + 7 * 86_400_000).toISOString(), "lab")).toThrow();
    expect(() => requireFreshBatchArchive(result, binding, now, now, "production")).toThrow();
    for (const body of [
      { ...fixture(), archive_created_at: changed, archive_completed_at: "2026-10-07T23:00:00.000Z" },
      { ...fixture(), retention: { ...fixture().retention, retain_until: now } },
      { ...fixture(), retention: { ...fixture().retention, days: 115 } },
      { ...fixture(), retention: { ...fixture().retention, mode: "COMPLIANCE" } }
    ]) expect(() => requireFreshBatchArchive(parseVerifiedBatchArchive(body), binding, now, now, "lab")).toThrow();
  });
});
