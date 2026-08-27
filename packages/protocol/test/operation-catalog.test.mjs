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
});

test("only catalog-declared dry runs downgrade mutation classification", () => {
  for (const operation of ["delete", "rename"]) {
    assert.equal(mutationOperationIdentifier(operation, { dry_run: true }), null);
  }

  for (const operation of [
    "create_type",
    "apply_type_pack",
    "apply_collection_setup",
    "update_type",
    "create_view_source",
    "update_view_source",
    "delete_view_source"
  ]) {
    assert.equal(mutationOperationIdentifier(operation, { dry_run: true }), operation);
  }

  assert.equal(
    mutationOperationIdentifier("sync", { action: "mutate", dry_run: true }),
    "sync:mutate"
  );
  for (const type of [
    "open_file_upload",
    "move_file",
    "delete_file",
    "commit_file_upload",
    "abort_file_transfer"
  ]) {
    assert.equal(
      mutationOperationIdentifier("file_control", { type, dry_run: true }),
      `file_control:${type}`
    );
  }
  for (const type of ["list_files", "open_file_download", "get_file_transfer_status"]) {
    assert.equal(mutationOperationIdentifier("file_control", { type, dry_run: true }), null);
  }
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
