import assert from "node:assert/strict";
import test from "node:test";
import { groupAccess, presentCollection, presentConnection } from "../src/renderer/daemon-view.mts";

test("connection: unknown, stopped, signed out, signing in and online are distinct", () => {
  assert.equal(presentConnection(null, false).dot, "connecting");
  assert.equal(presentConnection(null, true).label, "mdbase is not running");
  assert.equal(presentConnection({ account: { signed_in: false, online: false } }, true).label, "Not signed in");
  assert.equal(presentConnection({ account: { signed_in: false, online: false, pairing: "https://x" } }, true).label, "Waiting for sign-in approval");
  assert.equal(presentConnection({ account: { signed_in: true, online: true } }, true).dot, "connected");
});

test("collections: sync is offered only for a ready local collection; waiting work is never shown as up to date", () => {
  const local = presentCollection({ mode: "local", state: "ready" });
  assert.deepEqual([local.canEnableSync, local.canDisableSync, local.status], [true, false, "Ready"]);
  assert.equal(presentCollection({ mode: "local", state: "opening" }).canEnableSync, false);
  const busy = presentCollection({ mode: "synced_e2e", state: "ready", sync: { pending: 2, holds: 1, unresolved: 0, connection: "online" } });
  assert.equal(busy.status, "Syncing…");
  assert.equal(busy.dot, "paused");
  assert.match(busy.detail, /2 changes to upload · 1 file waiting/);
  assert.equal(busy.canDisableSync, true);
  assert.match(presentCollection({ mode: "local", state: "failed", reason: "folder_missing" }).detail, /files are untouched/);
});

test("access: pending, served-by-app and refused are separated; badge counts decisions and new notices", () => {
  const entry = (grant, app, state, acknowledged = true) => ({ grant, collection: "c", app_id: app, app_name: app, state, acknowledged });
  const groups = groupAccess([
    entry("1", "Reader", "active", false), entry("2", "Reader", "active"), entry("3", "Planner", "pending_approval"),
    entry("4", "Old", "revoked_locally"), entry("5", "Tasks", "active")
  ]);
  assert.deepEqual(groups.pending.map((e) => e.grant), ["3"]);
  assert.deepEqual(groups.apps.map((a) => [a.appName, a.grants.length]), [["Reader", 2], ["Tasks", 1]]);
  assert.deepEqual(groups.refused.map((e) => e.grant), ["4"]);
  assert.equal(groups.attention, 2);
});
