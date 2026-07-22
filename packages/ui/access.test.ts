import assert from "node:assert/strict";
import test from "node:test";
import { groupApplicationAccess } from "./access.ts";

test("groups repeated grants under a stable application identity", () => {
  const groups = groupApplicationAccess([
    grant("second", "app-b", "Budget", "collection-b", "2026-07-22T02:00:00Z"),
    grant("newest", "app-a", "Notes", "collection-a", "2026-07-22T03:00:00Z"),
    grant("oldest", "app-a", "Notes", "collection-a", "2026-07-22T01:00:00Z"),
    grant("other", "app-a", "Archive", "collection-c", "2026-07-22T02:00:00Z")
  ]);

  assert.deepEqual(groups.map((group) => group.applicationId), ["app-a", "app-b"]);
  assert.equal(groups[0].collectionCount, 2);
  assert.deepEqual(groups[0].grants.map((item) => item.id), ["other", "newest", "oldest"]);
});

test("does not mutate the incoming grant order", () => {
  const grants = [
    grant("newest", "app-a", "Notes", "collection-a", "2026-07-22T03:00:00Z"),
    grant("oldest", "app-a", "Notes", "collection-a", "2026-07-22T01:00:00Z")
  ];

  groupApplicationAccess(grants);

  assert.deepEqual(grants.map((item) => item.id), ["newest", "oldest"]);
});

function grant(id: string, applicationId: string, collectionName: string, collectionId: string, createdAt: string) {
  return {
    id,
    application_id: applicationId,
    application_name: applicationId === "app-a" ? "Alpha" : "Beta",
    collection_id: collectionId,
    collection_name: collectionName,
    created_at: createdAt
  };
}
