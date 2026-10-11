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

test("account refusals no retry can fix cancel the window in plain words; others stay retryable", () => {
  const legacy = model.installationRefusal({ status: 409, code: "installation_legacy_backend", message: "This account still uses the legacy backend. Finish migrating the account before approving this device sign-in." }, "mdbase editor");
  assert.equal(legacy.cancel, true);
  assert.match(legacy.message, /mdbase editor/);
  assert.doesNotMatch(legacy.message, /legacy|backend|migrat/i);
  const upgrading = model.installationRefusal({ status: 409, code: "installation_legacy_backend", message: "x", details: { upgrade: "in_progress" } }, "Reader");
  assert.equal(upgrading.cancel, false);
  assert.match(upgrading.message, /being upgraded/);
  assert.match(upgrading.message, /try again/i);
  const unscheduled = model.installationRefusal({ status: 409, code: "installation_legacy_backend", message: "x", details: { upgrade: "not_scheduled" } }, "Reader");
  assert.equal(unscheduled.cancel, true);
  assert.match(unscheduled.message, /support@mdbase\.dev/);
  assert.equal(model.installationRefusal({ status: 403, code: "strict_device_approval", message: "x" }, "Reader").cancel, true);
  for (const reason of [{ status: 503, code: "busy", message: "Busy." }, new TypeError("Failed to fetch"), { status: 409, code: "installation_actor_conflict", message: "Conflict." }])
    assert.equal(model.installationRefusal(reason, "Reader").cancel, false);
  assert.match(model.installationRefusal(new TypeError("Failed to fetch"), "Reader").message, /try again/i);
});
