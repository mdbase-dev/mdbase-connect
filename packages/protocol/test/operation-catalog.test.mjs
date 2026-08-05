import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLECTION_OPERATIONS,
  FILE_CONTROL_MESSAGE_TYPES,
  MUTATING_OPERATION_IDENTIFIERS,
  isMutatingOperation,
  mutationOperationIdentifier
} from "../dist/operations.js";

test("the generated catalogue classifies every public mutation", () => {
  assert.deepEqual(
    COLLECTION_OPERATIONS.filter((operation) => isMutatingOperation(operation, {})),
    [
      "create_view_source",
      "update_view_source",
      "delete_view_source",
      "create",
      "update",
      "delete",
      "rename",
      "create_type",
      "update_type",
      "apply_type_pack",
      "apply_collection_setup",
      "put_timer",
      "cancel_timer",
      "reconcile_timers"
    ]
  );
  assert.equal(mutationOperationIdentifier("sync", { action: "mutate" }), "sync:mutate");
  assert.equal(mutationOperationIdentifier("sync", { action: "changes" }), null);
  assert.equal(mutationOperationIdentifier("delete", { dry_run: true }), null);
});

test("file-control mutations share the canonical recovery identifiers", () => {
  assert.deepEqual(
    FILE_CONTROL_MESSAGE_TYPES.filter((type) =>
      isMutatingOperation("file_control", { type })
    ),
    [
      "open_file_upload",
      "move_file",
      "delete_file",
      "commit_file_upload",
      "abort_file_transfer"
    ]
  );
  assert.deepEqual(MUTATING_OPERATION_IDENTIFIERS, [
    "create_view_source",
    "update_view_source",
    "delete_view_source",
    "create",
    "update",
    "delete",
    "rename",
    "create_type",
    "update_type",
    "apply_type_pack",
    "apply_collection_setup",
    "put_timer",
    "cancel_timer",
    "reconcile_timers",
    "sync:mutate",
    "file_control:open_file_upload",
    "file_control:move_file",
    "file_control:delete_file",
    "file_control:commit_file_upload",
    "file_control:abort_file_transfer"
  ]);
});
