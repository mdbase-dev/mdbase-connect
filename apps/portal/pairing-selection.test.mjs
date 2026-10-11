import assert from "node:assert/strict";
import test from "node:test";
import * as model from "./src/portal-model.ts";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const pairing = { account_selection_confirmed: true, collection_hint: a, collections: [{ collection_id: a }, { collection_id: b }] };

test("pairing inspection forwards only the collection hint, not other URL data", () => {
  assert.equal(model.pairingInspectionPath(a, `?collection_hint=${a}&return_to=%2F&token=do-not-forward`), `/v1/pairing-requests/${a}?collection_hint=${a}`);
  assert.equal(model.pairingInspectionPath(a, "?other=value"), `/v1/pairing-requests/${a}`);
});

test("pairing preselects an eligible hint only after explicit account confirmation", () => {
  assert.equal(model.initialInstallationCollection(pairing), a);
  assert.equal(model.initialInstallationCollection({ ...pairing, account_selection_confirmed: false }), "");
  assert.equal(model.initialInstallationCollection({ ...pairing, collections: [{ collection_id: b }] }), "");
  assert.equal(model.initialInstallationCollection({ ...pairing, collection_hint: null }), "");
});

test("unknown hints do not fall back to the sole available collection", () => {
  assert.equal(model.initialInstallationCollection({ ...pairing, collections: [{ collection_id: b }] }), "");
  assert.equal(model.initialInstallationCollection({ account_selection_confirmed: true, collections: [{ collection_id: b }] }), "");
});

test("explicit approval and original creation take precedence over a hint", () => {
  assert.equal(model.initialInstallationCollection({ ...pairing, selected_collection_id: b }), b);
  assert.equal(model.initialInstallationCollection({ ...pairing, creation: { collection_id: b, completed: true } }), b);
  assert.equal(model.initialInstallationCollection({ ...pairing, creation: { collection_id: b, completed: false } }), "new-collection");
});
