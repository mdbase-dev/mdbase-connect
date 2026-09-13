import assert from "node:assert/strict";
import test from "node:test";
import { initialAuthorizationSelection } from "./src/authorization-review-state.ts";

test("requires explicit selection when one compatible collection is available", () => {
  assert.deepEqual(initialAuthorizationSelection(["one"], null), {
    collectionId: "",
    reviewing: false
  });
});

test("requires explicit selection when multiple compatible collections are available", () => {
  assert.deepEqual(initialAuthorizationSelection(["one", "two"], null), {
    collectionId: "",
    reviewing: false
  });
});

test("requires confirmation for a specifically requested compatible collection", () => {
  // A requested collection is represented by the sole visible compatible choice.
  assert.deepEqual(initialAuthorizationSelection(["requested"], null), {
    collectionId: "",
    reviewing: false
  });
});

test("discards a stale saved collection instead of silently replacing it", () => {
  assert.deepEqual(initialAuthorizationSelection(["current"], {
    collectionId: "stale",
    reviewing: true
  }), {
    collectionId: "",
    reviewing: false
  });
});

test("does not restore an unconfirmed selection saved by an older portal", () => {
  assert.deepEqual(initialAuthorizationSelection(["only"], {
    collectionId: "only",
    reviewing: true
  }), {
    collectionId: "",
    reviewing: false
  });
});

test("restores an explicit valid selection", () => {
  assert.deepEqual(initialAuthorizationSelection(["selected"], {
    collectionId: "selected",
    collectionConfirmed: true,
    reviewing: true
  }), {
    collectionId: "selected",
    reviewing: true
  });
});
