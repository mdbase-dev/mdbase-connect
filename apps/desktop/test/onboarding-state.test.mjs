import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_RECEIPT_KEY,
  consumePairingCompleted,
  markPairingCompleted,
  readCompletionReceipt,
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
