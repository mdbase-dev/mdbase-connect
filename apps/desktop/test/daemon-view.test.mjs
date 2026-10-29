import assert from "node:assert/strict";
import test from "node:test";
import { accountProblemText, describeActivity, groupAccess, presentCollection, presentConnection } from "../src/renderer/daemon-view.mts";

test("connection: unknown, stopped, signed out, signing in and online are distinct", () => {
  assert.equal(presentConnection(null, false).dot, "connecting");
  assert.equal(presentConnection(null, true).label, "mdbase is not running");
  assert.equal(presentConnection({ account: { signed_in: false, online: false } }, true).label, "Not signed in");
  assert.equal(presentConnection({ account: { signed_in: false, online: false, pairing: "https://x" } }, true).label, "Waiting for sign-in approval");
  assert.equal(presentConnection({ account: { signed_in: true, online: true } }, true).dot, "connected");
});

test("connection: an account problem is explained in plain words, never as a code", () => {
  const failing = presentConnection({ account: { signed_in: true, online: false, last_error: "device_registration_failed" } }, true);
  assert.equal(failing.dot, "danger");
  assert.match(failing.detail, /keeps trying/);
  const online = presentConnection({ account: { signed_in: true, online: true, last_error: "device_registration_failed" } }, true);
  assert.equal(online.dot, "connected");
  assert.match(online.detail, /could not register this computer/);
  assert.equal(presentConnection({ account: { signed_in: true, online: true } }, true).detail, undefined);
  assert.doesNotMatch(accountProblemText("some_new_reason"), /_/);
  assert.equal(accountProblemText(null), undefined);
});

test("collections: sync is offered only for a ready local collection; waiting work is never shown as up to date", () => {
  const local = presentCollection({ mode: "local", state: "ready" });
  assert.deepEqual([local.canEnableSync, local.status], [true, "Ready"]);
  assert.equal("canDisableSync" in local, false);
  assert.equal(presentCollection({ mode: "local", state: "opening" }).canEnableSync, false);
  const busy = presentCollection({ mode: "synced_e2e", state: "ready", sync: { pending: 2, holds: 1, unresolved: 0, connection: "online" } });
  assert.equal(busy.status, "Syncing…");
  assert.equal(busy.dot, "paused");
  assert.match(busy.detail, /2 changes to sync · 1 file waiting/);
  assert.equal(busy.canEnableSync, false);
  assert.match(presentCollection({ mode: "local", state: "failed", reason: "folder_missing" }).detail, /files are untouched/);
  assert.match(presentCollection({ mode: "local", state: "unavailable", reason: "old_connector_running" }).detail, /old mdbase Connect is running/);
  const turningOn = presentCollection({ mode: "local", state: "paused", reason: "private_sync_pending" });
  assert.deepEqual([turningOn.status, turningOn.dot], ["Turning on Private sync…", "connecting"]);
  assert.match(turningOn.detail, /finishes this on its own; your files are untouched/);
  assert.equal(presentCollection({ mode: "local", state: "paused" }).status, "Paused");
});

test("connection follows collection outages even while the account relay is online", () => {
  const account = { signed_in: true, online: true };
  const collection = { mode: "synced", state: "opening", sync: { pending: 1, holds: 0, unresolved: 0, connection: "offline" } };
  assert.equal(presentConnection({ account, collections: [collection] }, true).label, "Offline");
  assert.equal(presentConnection({ account, collections: [{ ...collection, sync: { ...collection.sync, connection: "connecting" } }] }, true).dot, "connecting");
  assert.equal(presentConnection({ account, collections: [{ ...collection, state: "paused" }] }, true).dot, "connected");
  assert.equal(presentConnection({ account, collections: [{ ...collection, mode: "local" }] }, true).dot, "connected");
  assert.equal(presentConnection({ account, collections: [{ ...collection, state: "failed" }] }, true).dot, "connected");
  assert.equal(presentConnection({ account, collections: [{ ...collection, sync: { ...collection.sync, connection: "online" } }] }, true).dot, "connected");
});

test("clock problems have an actionable explanation", () => {
  const status = { account: { signed_in: true, online: false, last_error: "system_clock_wrong" }, collections: [{ mode: "local", state: "ready" }] };
  assert.match(presentConnection(status, true).detail, /system clock looks wrong/);
  assert.equal(presentCollection(status.collections[0]).detail, undefined);
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

test("activity reads as sentences and never hides an unknown kind", () => {
  assert.equal(describeActivity({ kind: "sync_enabled", collection_name: "Notes", detail: "synced_e2e" }), "Notes now syncs privately");
  assert.equal(describeActivity({ kind: "app_revoked", app_name: "Reader", collection_name: "Notes" }), "You revoked Reader on Notes");
  assert.equal(describeActivity({ kind: "collection_taken_over", collection_name: "Notes" }), "Notes moved here from mdbase Connect (its files were not touched)");
  assert.equal(describeActivity({ kind: "files_held" }), "files held");
});

test("deleted collections explain the terminal state and local removal", () => {
  const view = presentCollection({ mode: "synced", state: "failed", reason: "collection_deleted",
    sync: { pending: 3, holds: 0, unresolved: 0, connection: "offline", resyncing: true } });
  assert.equal(view.status, "Collection deleted");
  assert.equal(view.mode, "Sync stopped");
  assert.match(view.detail, /deleted by its owner/);
  assert.match(view.detail, /local files are untouched/);
  assert.match(view.detail, /Remove/);
  assert.equal(view.canEnableSync, false);
  assert.equal("canDisableSync" in view, false);
});

test("revoked collection shows manual recovery even with stale connecting telemetry", () => {
  const view = presentCollection({ mode: "synced", state: "failed", reason: "sync_revoked",
    notices: [{ code: "sync_revoked", message: "This computer was removed from this collection and can no longer sync it. To rejoin, use a new device identity in a separate mdbase profile (--state-dir), sign in, and join the collection into a new empty folder. Local edits held in this folder are kept for you to copy across. Keep this folder and the old profile until you have copied your edits." }],
    sync: { pending: 19, holds: 19, unresolved: 0, connection: "connecting", resyncing: true } });
  assert.equal(view.status, "Stopped");
  assert.equal(view.dot, "danger");
  assert.equal(view.canEnableSync, false);
  assert.match(view.detail, /was removed from this collection and can no longer sync it/);
  assert.match(view.detail, /new empty folder/);
  assert.match(view.detail, /Local edits held in this folder are kept/);
  assert.match(view.detail, /separate mdbase profile/);
  assert.equal(view.holds, 19);
});
