import assert from "node:assert/strict";
import test from "node:test";
import { presentConnection } from "../src/renderer/connection-state.mts";

test("connection presentation distinguishes startup, progress, and completion", () => {
  assert.deepEqual(presentConnection(null, null), {
    label: "Checking connection…",
    settingsLabel: "Checking",
    dot: "connecting"
  });
  assert.deepEqual(presentConnection(null, { configured: false }), {
    label: "Local only",
    settingsLabel: "Local only",
    dot: "idle"
  });
  assert.deepEqual(presentConnection(null, { configured: true }), {
    label: "Connecting securely…",
    settingsLabel: "Connecting",
    dot: "connecting"
  });
  assert.deepEqual(
    presentConnection({ state: "connecting", paused: false }, { configured: true }),
    { label: "Connecting securely…", settingsLabel: "Connecting", dot: "connecting" }
  );
  assert.deepEqual(
    presentConnection({ state: "local_only", paused: false }, { configured: true }),
    { label: "Connecting securely…", settingsLabel: "Connecting", dot: "connecting" }
  );
  assert.deepEqual(
    presentConnection({ state: "connected", paused: false }, { configured: true }),
    { label: "Connected securely", settingsLabel: "Connected", dot: "connected" }
  );
});

test("permanent policy failures name the local recovery rather than an update", () => {
  for (const [relay_problem, label] of [
    ["policy_authority_mismatch", "Computer registration changed; disconnect and reconnect this computer"],
    ["policy_state_missing", "Local authorization state is damaged; restore a verified backup"],
    ["registration_restart_required", "Computer registration changed; restart the connector"],
    ["authentication_required", "Account connection needs authorization; reconnect this computer"],
    ["incompatible_version", "Relay version incompatible; update the connector"],
    ["future_problem", "Account connection needs attention"]
  ]) {
    for (const paused of [false, true]) {
      assert.deepEqual(presentConnection({ state: "offline", paused, relay_problem }, { configured: true }), {
        label, settingsLabel: "Needs attention", dot: "danger"
      });
    }
  }
});

test("paused and offline states remain explicit", () => {
  assert.deepEqual(
    presentConnection({ state: "connected", paused: true }, { configured: true }),
    { label: "Remote access paused", settingsLabel: "Paused", dot: "paused" }
  );
  assert.deepEqual(
    presentConnection({ state: "offline", paused: false }, { configured: true }),
    { label: "Connector offline", settingsLabel: "Offline", dot: "idle" }
  );
});
