import assert from "node:assert/strict";
import test from "node:test";
import { message } from "../src/renderer/view-model.ts";

for (const name of ["Error", "AgentControlError"]) {
  test(`Electron's ${name} wrapper does not obscure the local repair`, () => {
    const detail = "The selected folder does not contain mdbase.yaml. Choose an mdbase collection folder.";
    assert.equal(message(new Error(`Error invoking remote method 'connect:collections:add': ${name}: ${detail}`)), detail);
  });
}

test("plain errors and internal invariant failures retain their detail", () => {
  assert.equal(message(new Error("Choose a folder.")), "Choose a folder.");
  assert.equal(message(new Error("Error invoking remote method 'connect:status': TypeError: Invalid internal state")), "TypeError: Invalid internal state");
});

test("transport wrappers do not alter existing pairing and network guidance", () => {
  assert.equal(message(new Error("Error invoking remote method 'connect:pairing:status': Error: That pairing request expired. Start again.")), "This computer setup request expired. Start again to create a new one.");
  assert.equal(message(new Error("Error invoking remote method 'connect:pairing:begin': TypeError: Failed to fetch")), "mdbase connect could not reach the service. Check your connection and try again.");
});
