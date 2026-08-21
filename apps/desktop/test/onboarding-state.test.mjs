import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_RECEIPT_KEY,
  TRANSFER_RECEIPT_KEY,
  clearTransferProgress,
  clearTransferReceipt,
  consumePairingCompleted,
  markPairingCompleted,
  readCompletionReceipt,
  readTransferReceipt,
  readTransferProgress,
  writeTransferProgress,
  writeTransferReceipt,
  writeCompletionReceipt
} from "../src/renderer/onboarding-state.mts";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
}

test("pairing completion is consumed once", () => {
  const target = storage();
  assert.equal(consumePairingCompleted(target), false);
  markPairingCompleted(target);
  assert.equal(consumePairingCompleted(target), true);
  assert.equal(consumePairingCompleted(target), false);
});

test("collection completion receipts survive renderer restarts", () => {
  const target = storage();
  const receipt = { collectionId: "collection-1", collectionName: "Notes", authority: "local", path: "/Notes" };
  writeCompletionReceipt(target, receipt);
  assert.deepEqual(readCompletionReceipt(target), receipt);
});

test("invalid completion receipt data is discarded", () => {
  const target = storage({ [COMPLETION_RECEIPT_KEY]: '{"authority":"somewhere"}' });
  assert.equal(readCompletionReceipt(target), null);
  assert.equal(target.getItem(COMPLETION_RECEIPT_KEY), null);
});

test("authority transfer receipts survive renderer restarts until dismissed", () => {
  const target = storage();
  const receipt = {
    collectionId: "collection-1",
    collectionName: "Notes",
    direction: "hosted_to_local",
    newMainCopy: "/Notes",
    oldAuthority: "Hosted recovery copy",
    applications: ["Tasks"],
    replicas: ["Laptop"],
    completedAt: "2026-08-22T00:00:00.000Z"
  };
  writeTransferReceipt(target, receipt);
  assert.deepEqual(readTransferReceipt(target), receipt);
  clearTransferReceipt(target);
  assert.equal(target.getItem(TRANSFER_RECEIPT_KEY), null);
});

test("invalid authority transfer receipt data is discarded", () => {
  const target = storage({ [TRANSFER_RECEIPT_KEY]: '{"direction":"sideways"}' });
  assert.equal(readTransferReceipt(target), null);
  assert.equal(target.getItem(TRANSFER_RECEIPT_KEY), null);
});

test("an interrupted local authority transfer remains resumable", () => {
  const target = storage();
  const progress = {
    collectionId: "collection-1",
    collectionName: "Notes",
    direction: "local_to_hosted",
    phase: "uploading"
  };
  writeTransferProgress(target, progress);
  assert.deepEqual(readTransferProgress(target), progress);
  clearTransferProgress(target);
  assert.equal(readTransferProgress(target), null);
});
