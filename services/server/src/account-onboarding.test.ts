import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  provisionStarterCollection,
  scheduleStarterCollection,
  starterEditorUrl
} from "./account-onboarding.js";
import { createDatabase } from "./db.js";
import { ensureDevelopmentEntitlement } from "./entitlements.js";
import type { HostedProviderClient } from "./hosted-provider.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("account onboarding", () => {
  it("provisions one starter collection and never recreates it after deletion", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, NULL, 'New user')",
      [userId]
    );
    await ensureDevelopmentEntitlement(db, userId);
    const scheduledId = await scheduleStarterCollection(
      db,
      userId,
      "Australia/Melbourne"
    );
    expect(await scheduleStarterCollection(db, userId, "UTC")).toBe(scheduledId);

    const createCollection = vi.fn(async () => undefined);
    const options = {
      db,
      hostedCollections: true,
      hostedProvider: fakeProvider({ createCollection })
    };
    const first = await provisionStarterCollection(
      options,
      "http://connect.test",
      userId
    );
    const repeated = await provisionStarterCollection(
      options,
      "http://connect.test",
      userId
    );
    expect(first).toEqual({ status: "ready", collectionId: scheduledId });
    expect(repeated).toEqual(first);

    const collections = await db.query(
      "SELECT id, display_name, template FROM hosted_collections WHERE user_id = $1",
      [userId]
    );
    expect(collections.rows).toEqual([{
      id: scheduledId,
      display_name: "Welcome to mdbase",
      template: "onboarding"
    }]);
    expect(createCollection).toHaveBeenCalledTimes(1);
    expect(createCollection).toHaveBeenCalledWith(
      expect.any(String),
      scheduledId,
      "onboarding",
      "Welcome to mdbase",
      "Australia/Melbourne"
    );

    await db.query("DELETE FROM hosted_collections WHERE id = $1", [scheduledId]);
    expect(await provisionStarterCollection(
      options,
      "http://connect.test",
      userId
    )).toEqual({ status: "deleted", collectionId: scheduledId });
  });

  it("releases a failed provisioning claim so the same collection can retry", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, NULL, 'Retry user')",
      [userId]
    );
    await ensureDevelopmentEntitlement(db, userId);
    const collectionId = await scheduleStarterCollection(db, userId);
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(undefined);
    const options = {
      db,
      hostedCollections: true,
      hostedProvider: fakeProvider({ createCollection: create })
    };

    await expect(provisionStarterCollection(
      options,
      "http://connect.test",
      userId
    )).rejects.toThrow("provider unavailable");
    expect(await provisionStarterCollection(
      options,
      "http://connect.test",
      userId
    )).toEqual({ status: "ready", collectionId });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      collectionId,
      "onboarding",
      "Welcome to mdbase",
      "UTC"
    );
  });

  it("builds a direct editor URL without granting the editor access", () => {
    expect(starterEditorUrl(
      "https://editor.mdbase.dev",
      "https://connect.mdbase.dev",
      "019c0000-0000-7000-8000-000000000099"
    )).toBe(
      "https://editor.mdbase.dev/?server=https%3A%2F%2Fconnect.mdbase.dev&collection=019c0000-0000-7000-8000-000000000099"
    );
  });
});

function fakeProvider(overrides: Record<string, unknown>): HostedProviderClient {
  return {
    url: "https://provider.test",
    upsertAccount: async () => ({}),
    ...overrides
  } as unknown as HostedProviderClient;
}
