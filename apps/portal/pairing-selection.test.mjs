import assert from "node:assert/strict";
import test from "node:test";
import * as model from "./src/portal-model.ts";

const a = "11111111-1111-4111-8111-111111111111";

test("pairing inspection forwards only the collection hint, not other URL data", () => {
  assert.equal(model.pairingInspectionPath(a, `?collection_hint=${a}&return_to=%2F&token=do-not-forward`), `/v1/pairing-requests/${a}?collection_hint=${a}`);
  assert.equal(model.pairingInspectionPath(a, "?other=value"), `/v1/pairing-requests/${a}`);
});

test("the existing last-used collection preference is shared with portal navigation", () => {
  const location = Object.getOwnPropertyDescriptor(globalThis, "location"), storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://connect.example" } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
    assert.equal(model.readRememberedCollection(), null);
    model.rememberCollection(a);
    assert.equal(values.get("mdbase-connect:last-collection:https://connect.example"), a);
    assert.equal(model.readRememberedCollection(), a);
  } finally {
    if (location) Object.defineProperty(globalThis, "location", location); else delete globalThis.location;
    if (storage) Object.defineProperty(globalThis, "localStorage", storage); else delete globalThis.localStorage;
  }
});

test("unavailable preference storage does not prevent choosing a collection", () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("denied"); } });
    assert.equal(model.readRememberedCollection(), null);
    assert.doesNotThrow(() => model.rememberCollection(a));
  } finally {
    if (storage) Object.defineProperty(globalThis, "localStorage", storage); else delete globalThis.localStorage;
  }
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
  const postponed = model.installationRefusal({ status: 409, code: "installation_legacy_backend", message: "x", details: { upgrade: "postponed" } }, "Reader");
  assert.equal(postponed.cancel, true);
  assert.equal(postponed.heading, "Account upgrade paused");
  assert.match(postponed.message, /Reader can't use it yet/);
  assert.match(postponed.message, /current mdbase apps/);
  assert.doesNotMatch(postponed.message, /being upgraded|try again|legacy|backend|migrat/i);
  const unscheduled = model.installationRefusal({ status: 409, code: "installation_legacy_backend", message: "x", details: { upgrade: "not_scheduled" } }, "Reader");
  assert.equal(unscheduled.cancel, true);
  assert.match(unscheduled.message, /support@mdbase\.dev/);
  assert.equal(model.installationRefusal({ status: 403, code: "strict_device_approval", message: "x" }, "Reader").cancel, true);
  for (const reason of [{ status: 503, code: "busy", message: "Busy." }, new TypeError("Failed to fetch"), { status: 409, code: "installation_actor_conflict", message: "Conflict." }])
    assert.equal(model.installationRefusal(reason, "Reader").cancel, false);
  assert.match(model.installationRefusal(new TypeError("Failed to fetch"), "Reader").message, /try again/i);
});

test("Cancel on an app's sign-in window closes it and never navigates into the Editor", () => {
  const calls = [];
  const target = { close: () => calls.push("close"), location: { href: "https://connect.example/pair/x" } };
  assert.equal(model.finishDeniedPairing({ installation_device: true }, target), "cancelled");
  assert.deepEqual(calls, ["close"]);
  assert.equal(target.location.href, "https://connect.example/pair/x");
  const stubborn = { close: () => { throw new Error("blocked"); }, location: { href: "unchanged" } };
  assert.equal(model.finishDeniedPairing({ installation_device: true }, stubborn), "cancelled");
  assert.equal(stubborn.location.href, "unchanged");
  const computer = { close: () => calls.push("computer-close"), location: { href: "" } };
  assert.equal(model.finishDeniedPairing({ installation_device: false }, computer), "home");
  assert.equal(computer.location.href, "/");
  assert.deepEqual(calls, ["close"]);
});
