import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationOperationLabel,
  applicationAccessOriginLabel,
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

test("groups manifest revisions by application family without changing grant identity", () => {
  const groups = groupApplicationAccess([
    {
      ...grant("old", "revision-a", "Notes", "collection-a", "2026-07-22T01:00:00Z"),
      application_family_id: "bundle:dev.mdbase.notes"
    },
    {
      ...grant("new", "revision-b", "Archive", "collection-b", "2026-07-22T02:00:00Z"),
      application_family_id: "bundle:dev.mdbase.notes"
    }
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].applicationId, "bundle:dev.mdbase.notes");
  assert.deepEqual(new Set(groups[0].grants.map((item) => item.application_id)), new Set([
    "revision-a",
    "revision-b"
  ]));
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
        label: "Create and edit records",
        description: "Create, edit, rename, or move records.",
        operations: [{ id: "create", label: "Create records" }]
      },
      {
        id: "delete",
        label: "Delete records",
        description: "Permanently remove records from this collection.",
        operations: [{ id: "delete", label: "Delete records" }]
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

test("keeps transport capabilities out of the user's permission checklist", () => {
  assert.deepEqual(groupAuthorizationOperations(["read", "sync"]), [{
    id: "view",
    label: "View and find records",
    description: "Read collection details, records, saved views, and type definitions.",
    operations: [{ id: "read", label: "Read records" }]
  }]);
  assert.deepEqual(groupAuthorizationOperations(["sync"]), []);
});

test("keeps application timers in a distinct permission category", () => {
  assert.deepEqual(groupAuthorizationOperations(["list_timers", "put_timer"]), [{
    id: "schedule",
    label: "Schedule app activity",
    description: "View and manage timers owned by this application.",
    operations: [
      { id: "list_timers", label: "See this app's scheduled activity" },
      { id: "put_timer", label: "Create or update this app's scheduled activity" }
    ]
  }]);
});

test("record definitions, setup and scheduled work have concrete permission labels without changing operation IDs", () => {
  const labels = {
    read_type: "View record types", create_type: "Add record types", update_type: "Change record types",
    assess_type_pack: "Check available record types", apply_type_pack: "Install or update record types",
    assess_collection_setup: "Check what this app needs to set up", apply_collection_setup: "Set up this app in the collection",
    list_timers: "See this app's scheduled activity", put_timer: "Create or update this app's scheduled activity",
    cancel_timer: "Cancel this app's scheduled activity", reconcile_timers: "Replace this app's scheduled activity"
  };
  const operations = Object.keys(labels);
  for (const [operation, label] of Object.entries(labels)) assert.equal(authorizationOperationLabel(operation), label);
  assert.deepEqual(new Set(groupAuthorizationOperations(operations).flatMap(group => group.operations.map(row => row.id))), new Set(operations));
});

test("loopback web origins are identified as local development without trusting lookalike hosts or mobile schemes", () => {
  for (const origin of ["http://127.0.0.1:48220", "http://localhost:48220", "http://[::1]:48220"])
    assert.equal(applicationAccessOriginLabel(origin), `Local development (${new URL(origin).host})`);
  assert.equal(applicationAccessOriginLabel("https://lab.tasknotes-app.pages.dev"), "lab.tasknotes-app.pages.dev");
  assert.equal(applicationAccessOriginLabel("https://127.0.0.1.example.com"), "127.0.0.1.example.com");
  assert.equal(applicationAccessOriginLabel("capacitor://localhost"), "localhost");
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
