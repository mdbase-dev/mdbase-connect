import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationOperationLabel,
  groupApplicationAccess,
  groupAuthorizationOperations
} from "./access.ts";

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

test("groups requested operations into plain-language permission categories", () => {
  assert.deepEqual(
    groupAuthorizationOperations(["read", "query", "create", "delete", "create_view_source"]),
    [
      {
        id: "view",
        label: "View and find records",
        description: "Read collection details, records, saved views, and type definitions.",
        operations: [
          { id: "read", label: "Read records" },
          { id: "query", label: "Search and query" }
        ]
      },
      {
        id: "change",
        label: "Change records",
        description: "Create, edit, rename, move, or delete records.",
        operations: [
          { id: "create", label: "Create records" },
          { id: "delete", label: "Delete records" }
        ]
      },
      {
        id: "manage",
        label: "Manage collection structure",
        description: "Create or change saved views and type definitions.",
        operations: [
          { id: "create_view_source", label: "Create saved views" }
        ]
      }
    ]
  );
});

test("keeps unknown operations visible and readable", () => {
  assert.deepEqual(groupAuthorizationOperations(["publish_archive"]), [{
    id: "other",
    label: "Other permissions",
    description: "Additional operations declared by this application.",
    operations: [{ id: "publish_archive", label: "Publish archive" }]
  }]);
  assert.equal(authorizationOperationLabel("publish_archive"), "Publish archive");
});

test("keeps application timers in a distinct permission category", () => {
  assert.deepEqual(groupAuthorizationOperations(["list_timers", "put_timer"]), [{
    id: "schedule",
    label: "Schedule app activity",
    description: "View and manage timers owned by this application.",
    operations: [
      { id: "list_timers", label: "List application timers" },
      { id: "put_timer", label: "Create or update timers" }
    ]
  }]);
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
