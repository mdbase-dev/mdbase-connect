import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  provisionStarterCollection,
  scheduleStarterCollection,
  starterEditorUrl
} from "./account-onboarding.js";
import { createDatabase } from "./db.js";
import { HostedAuthorityRegistry } from "./hosted.js";

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
    const scheduledId = await scheduleStarterCollection(
      db,
      userId,
      "Australia/Melbourne"
    );
    expect(await scheduleStarterCollection(db, userId, "UTC")).toBe(scheduledId);

    const hostedReference = new HostedAuthorityRegistry(db);
    const options = { db, hostedCollections: true };
    const first = await provisionStarterCollection(
      options,
      hostedReference,
      "http://connect.test",
      userId
    );
    const repeated = await provisionStarterCollection(
      options,
      hostedReference,
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
    const authority = await db.query<{ state: { records: Array<{ path: string }> } }>(
      "SELECT state FROM hosted_authority_states WHERE collection_id = $1",
      [scheduledId]
    );
    expect(authority.rows[0]?.state.records.map(({ path }) => path)).toEqual([
      "Start here.md",
      "How collections work.md",
      "Build with mdbase.md"
    ]);

    const replicaId = await hostedReference.registerReplica(scheduledId, {
      name: "Editor test",
      mode: "read_write"
    });
    const operationContext = {
      displayName: "Welcome to mdbase",
      operations: ["describe", "query", "read", "update"]
    };
    const query = await hostedReference.applicationOperation(
      scheduledId,
      replicaId,
      "query",
      { include_body: true },
      operationContext
    ) as { result: { results: Array<{ path: string }> } };
    expect(query.result.results).toHaveLength(3);
    const read = await hostedReference.applicationOperation(
      scheduledId,
      replicaId,
      "read",
      { path: "Start here.md", include_document: true },
      operationContext
    ) as { result: { revision: string } };
    const updated = await hostedReference.applicationOperation(
      scheduledId,
      replicaId,
      "update",
      {
        path: "Start here.md",
        document: "# Welcome\n\nThe local replay works.\n",
        if_revision: read.result.revision,
        include_document: true
      },
      operationContext
    ) as { result: { document: string } };
    expect(updated.result.document).toContain("local replay works");

    await hostedReference.delete(scheduledId);
    await db.query("DELETE FROM hosted_collections WHERE id = $1", [scheduledId]);
    expect(await provisionStarterCollection(
      options,
      hostedReference,
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
    const collectionId = await scheduleStarterCollection(db, userId);
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(undefined);
    const hostedReference = { create } as unknown as HostedAuthorityRegistry;
    const options = { db, hostedCollections: true };

    await expect(provisionStarterCollection(
      options,
      hostedReference,
      "http://connect.test",
      userId
    )).rejects.toThrow("provider unavailable");
    expect(await provisionStarterCollection(
      options,
      hostedReference,
      "http://connect.test",
      userId
    )).toEqual({ status: "ready", collectionId });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(2, collectionId, "onboarding", "UTC");
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
