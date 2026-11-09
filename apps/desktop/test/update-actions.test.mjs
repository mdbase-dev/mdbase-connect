import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { updateActions } = createRequire(import.meta.url)("../dist/main/update-actions.js");

test("an external update offers opening its package and checking again", () => {
  // The tray and Settings both render this set.
  assert.deepEqual(updateActions({ phase: "external", can_check: true, can_install: true }), [
    { action: "install", enabled: true },
    { action: "check", enabled: true }
  ]);
});

test("the action set follows the update state without replacing checking", () => {
  assert.deepEqual(updateActions({ phase: "ready", can_check: true, can_install: true }), [
    { action: "install", enabled: true }
  ]);
  assert.deepEqual(updateActions({ phase: "idle", can_check: true, can_install: false }), [
    { action: "check", enabled: true }
  ]);
  assert.deepEqual(updateActions({ phase: "deferred", can_check: true, can_install: false }), [
    { action: "check", enabled: true }
  ]);
  assert.deepEqual(updateActions({ phase: "failed", can_check: true, can_install: false }), [
    { action: "check", enabled: true }
  ]);
  assert.deepEqual(updateActions({ phase: "checking", can_check: false, can_install: false }), [
    { action: "check", enabled: false }
  ]);
  assert.deepEqual(updateActions({ phase: "downloading", can_check: false, can_install: false }), [
    { action: "check", enabled: false }
  ]);
  assert.deepEqual(updateActions({ phase: "installing", can_check: false, can_install: false }), [
    { action: "check", enabled: false }
  ]);
});
