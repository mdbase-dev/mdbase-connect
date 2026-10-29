import assert from "node:assert/strict";
import test from "node:test";
import { message, syncEnableMessage } from "../src/renderer/view-model.ts";

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

test("sync quota guidance survives the daemon and Electron wrappers", () => {
  const detail = "Your account has reached its synced collection limit. Delete a synced collection before creating another.";
  const error = new Error(`Error invoking remote method 'connect:collections:sync-enable': DaemonControlError: ${detail}`);
  assert.equal(message(error), detail);
  assert.equal(syncEnableMessage(error), `Sync could not be turned on: ${detail} The folder and its files are unchanged.`);
});

test("transport wrappers do not alter sign-in and network guidance", () => {
  assert.equal(message(new Error("Error invoking remote method 'connect:collections:add': DaemonControlError: pair with an authenticated account before registering a local collection")), "Sign in to mdbase on this computer before adding a collection.");
  assert.equal(message(new Error("Error invoking remote method 'connect:account:sign-in': TypeError: Failed to fetch")), "mdbase connect could not reach the service. Check your connection and try again.");
});

test("a failed turn-on of sync is explained in plain words", () => {
  const wrapped = (detail) => new Error(`Error invoking remote method 'connect:collections:sync-enable': DaemonControlError: ${detail}`);
  const trust = syncEnableMessage(wrapped("this build has no authenticated trust for synced collections"));
  assert.match(trust, /^This version of mdbase can't turn on sync\. Update mdbase/);
  assert.match(trust, /files are unchanged/);
  assert.match(syncEnableMessage(wrapped("sign this computer in first (`mdbase account sign-in`)")), /^Sign in to mdbase on this computer/);
  const other = syncEnableMessage(wrapped("the collection is busy"));
  assert.equal(other, "Sync could not be turned on: The collection is busy. The folder and its files are unchanged.");
});
