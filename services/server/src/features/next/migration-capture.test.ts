import { describe, expect, it } from "vitest";
import { captureProjection } from "./migration-capture.js";

const account = "10000000-0000-0000-0000-000000000001", collection = "20000000-0000-0000-0000-000000000001";
const name = "test-capture", time = "2026-10-13T00:00:00.000Z";
const current = { binding: { batch_id: name }, frozenAt: null, inventory: [[account, [collection]]] as [string, string[]][] };
const row = () => ({ view: { account_id: account, cohort: name, hosted_collections: [collection], terminal_excluded: false },
  record: { suspended: false, terminal_excluded_at: null as Date | null } });
const refuse = (): never => { throw new Error("capture refused"); };

describe("data-only capture projection", () => {
  it("does not change the complete binding and does not add an authority verdict", () => {
    const result = captureProjection(name, current, refuse)([row()], time);
    expect(result.binding).toBe(current.binding);
    expect(Object.keys(result).sort()).toEqual(["binding", "frozen_at", "members", "observed_at", "schema"]);
    expect(result.members[0]?.export_collections).toEqual([collection]);
  });
  it.each(["missing-view", "missing-record", "other-account", "other-cohort", "missing-collection", "extra-collection", "terminal-mismatch"])("refuses an inconsistent projection: %s", mismatch => {
    const observed = row();
    if (mismatch === "other-account") observed.view.account_id = "foreign";
    if (mismatch === "other-cohort") observed.view.cohort = "foreign";
    if (mismatch === "missing-collection") observed.view.hosted_collections = [];
    if (mismatch === "extra-collection") observed.view.hosted_collections.push("foreign");
    if (mismatch === "terminal-mismatch") observed.record.terminal_excluded_at = new Date(time);
    const observation = { view: mismatch === "missing-view" ? null : observed.view,
      record: mismatch === "missing-record" ? undefined : observed.record };
    expect(() => captureProjection(name, current, refuse)([observation], time)).toThrow("capture refused");
  });
  it.each([0, 2])("refuses missing or extra member observations: %s", count => {
    expect(() => captureProjection(name, current, refuse)(Array.from({ length: count }, row), time)).toThrow("capture refused");
  });
  it("excludes terminal selection without changing held metadata or suspension", () => {
    const observed = row();
    observed.view.terminal_excluded = true;
    observed.record.terminal_excluded_at = new Date(time);
    observed.record.suspended = true;
    expect(captureProjection(name, current, refuse)([observed], time).members[0]).toMatchObject({
      view: { hosted_collections: [collection], terminal_excluded: true }, suspended: true,
      terminal_excluded_at: time, export_collections: []
    });
  });
  it("refuses over1MiB encoded metadata, without silently dropping fields", () => {
    const observed = row();
    const large = { ...observed, view: { ...observed.view, future_metadata: "x".repeat(1024 * 1024) } };
    expect(() => captureProjection(name, current, refuse)([large], time)).toThrow("capture refused");
  });
});
