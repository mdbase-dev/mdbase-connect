import assert from "node:assert/strict";
import test from "node:test";
import { message } from "../src/renderer/view-model.ts";

for (const name of ["Error", "DaemonControlError"]) {
  test(`Electron's ${name} wrapper does not obscure the local repair`, () => {
    const detail = "The selected folder does not contain mdbase.yaml. Choose an mdbase collection folder.";
    assert.equal(message(new Error(`Error invoking remote method 'connect:collections:add': ${name}: ${detail}`)), detail);
  });
}

test("plain errors and internal invariant failures retain their detail", () => {
  assert.equal(message(new Error("Choose a folder.")), "Choose a folder.");
  assert.equal(message(new Error("Error invoking remote method 'connect:status': TypeError: Invalid internal state")), "TypeError: Invalid internal state");
});

test("transport wrappers do not alter sign-in and network guidance", () => {
  assert.equal(message(new Error("Error invoking remote method 'connect:collections:add': DaemonControlError: pair with an authenticated account before registering a local collection")), "Sign in to mdbase on this computer before adding a collection.");
  assert.equal(message(new Error("Error invoking remote method 'connect:account:sign-in': TypeError: Failed to fetch")), "mdbase connect could not reach the service. Check your connection and try again.");
});
