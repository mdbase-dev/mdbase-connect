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
