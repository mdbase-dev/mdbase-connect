import assert from "node:assert/strict";
import test from "node:test";
import { initialAuthorizationSelection } from "./src/authorization-review-state.ts";

test("opens the review when exactly one compatible collection is available", () => {
  assert.deepEqual(initialAuthorizationSelection(["one"], null), {
    collectionId: "one",
    reviewing: true
  });
});

test("requires explicit selection when multiple compatible collections are available", () => {
  assert.deepEqual(initialAuthorizationSelection(["one", "two"], null), {
    collectionId: "",
    reviewing: false
  });
});

test("opens the review for a specifically requested compatible collection", () => {
  // A requested collection is represented by the sole visible compatible choice.
  assert.deepEqual(initialAuthorizationSelection(["requested"], null), {
    collectionId: "requested",
    reviewing: true
  });
});

test("discards a stale saved collection instead of silently replacing it among several", () => {
  assert.deepEqual(initialAuthorizationSelection(["current", "other"], {
    collectionId: "stale",
    collectionConfirmed: true,
    reviewing: true
  }), {
    collectionId: "",
    reviewing: false
  });
});

test("does not restore an unconfirmed selection saved by an older portal", () => {
  assert.deepEqual(initialAuthorizationSelection(["only", "other"], {
    collectionId: "only",
    reviewing: true
  }), {
    collectionId: "",
    reviewing: false
  });
});

test("restores an explicit valid selection", () => {
  assert.deepEqual(initialAuthorizationSelection(["selected", "other"], {
    collectionId: "selected",
    collectionConfirmed: true,
    reviewing: true
  }), {
    collectionId: "selected",
    reviewing: true
  });
});

test("restores a confirmed return to the collection step for a single collection", () => {
  assert.deepEqual(initialAuthorizationSelection(["only"], {
    collectionId: "only",
    collectionConfirmed: true,
    reviewing: false
  }), {
    collectionId: "only",
    reviewing: false
  });
});
