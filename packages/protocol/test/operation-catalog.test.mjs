import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  COLLECTION_OPERATIONS,
  FILE_CONTROL_MESSAGE_TYPES,
  MUTATING_OPERATION_IDENTIFIERS,
  isMutatingOperation,
  mutationOperationIdentifier,
  operationInputSchemaVersion
} from "../dist/operations.js";

const classificationFixture = JSON.parse(readFileSync(
  new URL("../schemas/operation-mutation-classification.v1.json", import.meta.url),
  "utf8"
));

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

test("generated mutation-classification fixtures cover the complete catalog", () => {
  const coveredCollections = new Set();
  const coveredFiles = new Set();
  for (const entry of classificationFixture.cases) {
    assert.equal(
      mutationOperationIdentifier(entry.operation, entry.input),
      entry.identifier,
      `${entry.operation} ${JSON.stringify(entry.input)}`
    );
    assert.equal(
      operationInputSchemaVersion(entry.operation, entry.input),
      entry.schema_version,
      `${entry.operation} schema`
    );
    if (COLLECTION_OPERATIONS.includes(entry.operation)) coveredCollections.add(entry.operation);
    if (entry.operation === "file_control" && FILE_CONTROL_MESSAGE_TYPES.includes(entry.input.type)) {
      coveredFiles.add(entry.input.type);
    }
  }
  assert.deepEqual([...coveredCollections], [...COLLECTION_OPERATIONS]);
  assert.deepEqual([...coveredFiles], [...FILE_CONTROL_MESSAGE_TYPES]);
});

test("unknown discriminators are explicit schema rejections, not generated oracle cases", () => {
  assert.throws(
    () => operationInputSchemaVersion("file_control", { type: "unknown_file_control" }),
    { message: "Unknown file-control message: unknown_file_control" }
  );
  assert.equal(mutationOperationIdentifier("sync", { action: "unknown" }), null);
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
