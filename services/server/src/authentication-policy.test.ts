import { afterEach, describe, expect, it } from "vitest";
import {
  AuthenticationPolicyStore,
  AuthenticationSettingsConflictError
} from "./authentication-policy.js";
import { createDatabase } from "./db.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("authentication policy", () => {
  it("uses deployment configuration until an audited database override exists", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const policy = new AuthenticationPolicyStore(db, "invite");

    await expect(policy.current()).resolves.toEqual({
      registrationMode: "invite",
      passwordAuthEnabled: false,
      emailDeliveryEnabled: false,
      termsVersion: null,
      privacyVersion: null,
      revision: 0,
      source: "runtime"
    });

    const updated = await policy.update({
      registrationMode: "invite",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: false,
      termsVersion: "2026-07-28",
      privacyVersion: "2026-07-28",
      expectedRevision: 0,
      updatedBy: "operator:test",
      reason: "Enable the staging password flow"
    });
    expect(updated).toMatchObject({
      registrationMode: "invite",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: false,
      revision: 1,
      source: "database"
    });
    await expect(policy.current()).resolves.toEqual(updated);

    const history = await db.query<{
      revision: number;
      updated_by: string;
      update_reason: string;
    }>("SELECT revision, updated_by, update_reason FROM authentication_settings_history");
    expect(history.rows).toEqual([{
      revision: 1,
      updated_by: "operator:test",
      update_reason: "Enable the staging password flow"
    }]);
  });

  it("uses optimistic concurrency and preserves every successful revision", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const policy = new AuthenticationPolicyStore(db, "closed");
    const first = await policy.update({
      registrationMode: "closed",
      passwordAuthEnabled: false,
      emailDeliveryEnabled: false,
      termsVersion: null,
      privacyVersion: null,
      expectedRevision: 0,
      updatedBy: "operator:first",
      reason: "Create the policy"
    });
    expect(first.revision).toBe(1);

    await expect(policy.update({
      registrationMode: "open",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: true,
      termsVersion: null,
      privacyVersion: null,
      expectedRevision: 0,
      updatedBy: "operator:stale",
      reason: "Stale update"
    })).rejects.toBeInstanceOf(AuthenticationSettingsConflictError);

    const second = await policy.update({
      registrationMode: "invite",
      passwordAuthEnabled: true,
      emailDeliveryEnabled: true,
      termsVersion: null,
      privacyVersion: null,
      expectedRevision: 1,
      updatedBy: "operator:second",
      reason: "Enable invited signup"
    });
    expect(second.revision).toBe(2);
    const history = await db.query<{ revision: number }>(
      "SELECT revision FROM authentication_settings_history ORDER BY revision"
    );
    expect(history.rows.map(({ revision }) => Number(revision))).toEqual([1, 2]);
  });

  it("requires attributable, reasoned updates", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const policy = new AuthenticationPolicyStore(db, "closed");
    const base = {
      registrationMode: "closed" as const,
      passwordAuthEnabled: false,
      emailDeliveryEnabled: false,
      termsVersion: null,
      privacyVersion: null,
      expectedRevision: 0
    };
    await expect(policy.update({
      ...base,
      updatedBy: "",
      reason: "A reason"
    })).rejects.toThrow(/valid actor/);
    await expect(policy.update({
      ...base,
      updatedBy: "operator:test",
      reason: ""
    })).rejects.toThrow(/concise reason/);
    await expect(policy.update({
      ...base,
      registrationMode: "invalid" as never,
      updatedBy: "operator:test",
      reason: "Invalid mode"
    })).rejects.toThrow(/mode is invalid/);
  });
});
