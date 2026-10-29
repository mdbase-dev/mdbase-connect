import assert from "node:assert/strict";
import test from "node:test";
import { presentTakeover } from "../src/renderer/takeover-state.mts";

const base = { record: null, revived: false, error: null, holds: {}, held_interrupted_writes: 0, waiting_for_migration_batch: false };

test("no old engine and nothing waiting shows nothing; a closed rollout gate explains the wait and offers no move", () => {
  assert.equal(presentTakeover(base).visible, false);
  for (const account_legacy of [undefined, false, true]) {
    const waiting = presentTakeover({ ...base, waiting_for_migration_batch: true, account_legacy });
    assert.equal(waiting.visible, true);
    assert.equal(waiting.canStart, false);
    assert.equal(waiting.title, "Your collections are waiting to move");
    assert.match(waiting.detail, /safe on disk/);
    assert.match(waiting.detail, /automatically when your account is upgraded, shortly/);
    assert.doesNotMatch(waiting.detail, /keeps syncing/);
  }
  const signIn = presentTakeover({ ...base, waiting_for_migration_batch: true, waiting_reason: "sign_in" });
  assert.equal(signIn.title, "Sign in to finish moving your collections");
  assert.match(signIn.detail, /Sign in on this computer/);
  assert.match(signIn.detail, /safe on disk/);
  assert.doesNotMatch(signIn.detail, /keeps syncing/);
  assert.equal(signIn.canStart, false);
  const unreachable = presentTakeover({ ...base, waiting_for_migration_batch: true, waiting_reason: "unreachable" });
  assert.match(unreachable.detail, /safe on disk/);
  assert.match(unreachable.detail, /can reach the server and confirm your account upgrade/);
  assert.doesNotMatch(unreachable.detail, /keeps syncing/);
  assert.match(presentTakeover({ ...base, waiting_for_migration_batch: true, waiting_reason: "account_not_upgraded" }).detail, /when your account is upgraded, shortly/);
  assert.equal(presentTakeover({ ...base, error: "boom" }).canStart, true);
  assert.equal(presentTakeover({ ...base, error: "boom", account_legacy: true }).canStart, false);
});

test("a legacy or rolled-back account never offers the move, and moved collections say what to do", () => {
  const postponed = presentTakeover({
    ...base,
    account_legacy: true,
    record: { state: "postponed", collections: { a: { state: "postponed", reason: "folder_locked" } } }
  });
  assert.equal(postponed.canStart, false);

  const moved = presentTakeover({
    ...base,
    account_legacy: true,
    record: { state: "complete", collections: { a: { state: "complete", registered: true } } }
  });
  assert.equal(moved.visible, true);
  assert.equal(moved.tone, "attention");
  assert.equal(moved.canStart, false);
  assert.equal(moved.title, "Your account still uses mdbase Connect");
  assert.match(moved.detail, /upgrade was paused/);
  assert.match(moved.advice, /support@mdbase\.dev/);
  assert.doesNotMatch(`${moved.title} ${moved.detail} ${moved.advice}`, /legacy|backend|rollback|rolled back/i);
});

test("captured mirror notices preserve the closed rollout gate", () => {
  const waiting = presentTakeover({
    ...base,
    waiting_for_migration_batch: true,
    account_legacy: true,
    mirror_imports: { h: { name: "Hosted", waiting: 1, registered: false } }
  });
  assert.equal(waiting.canStart, false);
  assert.equal(waiting.title, "Your collections are waiting to move");
  assert.equal(waiting.notices.length, 1);
});

test("a returned account with only a joined mirror does not falsely claim it syncs again", () => {
  const returned = presentTakeover({
    ...base,
    account_legacy: true,
    record: { state: "complete", collections: {} },
    mirror_imports: { h: {
      name: "Hosted", registered: true, waiting: 1,
      join: { state: "joined", folder: "/home/me/Hosted (synced)", cut_over: false }
    } }
  });
  assert.equal(returned.tone, "attention");
  assert.equal(returned.title, "Your account still uses mdbase Connect");
  assert.equal(returned.canStart, false);
  assert.equal(returned.offerStopMirrors, false);
  assert.deepEqual(returned.notices, []);
});

test("an unconfirmed retirement of the old connector stays visible after a move", () => {
  const done = { ...base, record: { state: "complete", collections: { a: { state: "complete", registered: true } } } };
  assert.equal(presentTakeover({ ...done, retirement: { retired: true, legacy_connector_id: "c" } }).visible, false);
  const pending = presentTakeover({ ...done, retirement: { retired: false, reason: "retirement_not_confirmed" } });
  assert.equal(pending.visible, true);
  assert.match(pending.incidents[0], /hasn't confirmed/);
});

test("a postponed move names the reason, what to do, and offers stopping mirrors only for mirror reasons", () => {
  const view = presentTakeover({
    ...base,
    record: { state: "postponed", collections: { a: { state: "postponed", reason: "mirrors_present" } } }
  }, { a: "Notes" });
  assert.equal(view.tone, "attention");
  assert.match(view.title, /^Migration postponed: /);
  assert.match(view.advice, /allow hosted mirrors to stop/);
  assert.equal(view.offerStopMirrors, true);
  assert.equal(view.canStart, true);
  assert.equal(view.rows[0].label, "Notes");

  const locked = presentTakeover({
    ...base,
    record: { state: "complete", collections: { a: { state: "complete" }, b: { state: "postponed", reason: "folder_locked" } } }
  });
  assert.equal(locked.offerStopMirrors, false);
  assert.match(locked.title, /another program/);
});

test("a run in progress cannot be started again; a clean finish hides the panel but incidents stay visible", () => {
  const running = presentTakeover({ ...base, record: { state: "started", collections: { a: { state: "pending" } } } });
  assert.equal(running.inProgress, true);
  assert.equal(running.canStart, false);

  const done = { ...base, record: { state: "complete", collections: { a: { state: "complete", registered: true } } } };
  assert.equal(presentTakeover(done).visible, false);
  const revived = presentTakeover({ ...done, revived: true });
  assert.equal(revived.visible, true);
  assert.match(revived.incidents[0], /started again/);
  const marker = presentTakeover({ ...base, record: { state: "complete", collections: { a: { state: "complete", marker_incident: true } } } });
  assert.match(marker.incidents[0], /marker/);
});

test("unsent edits from old hosted mirrors: waiting until joined, then conflicts and recovered copies are shown", () => {
  const done = { ...base, record: { state: "complete", collections: { a: { state: "complete", registered: true } } } };
  const imp = { mirror_root: "/home/me/Hosted notes", edits: 3, applied: 0, held: 0, recovered: [], waiting: 3, complete: false, registered: false };
  const waiting = presentTakeover({ ...done, mirror_imports: { h: imp } });
  assert.equal(waiting.visible, true);
  assert.equal(waiting.tone, "info");
  assert.deepEqual(waiting.incidents, []);
  assert.match(waiting.notices[0], /^3 edits made in “Hosted notes” before the move were not uploaded yet and are kept/);
  assert.match(waiting.notices[0], /adding “Hosted notes” back to this computer\. mdbase will retry shortly\./);

  const offline = presentTakeover({ ...done, mirror_imports: { h: { ...imp, join: {
    state: "waiting", folder: "/home/me/Hosted notes (synced)", reason: "sync_unreachable", attempts: 2, cut_over: false
  } } } });
  assert.match(offline.notices[0], /back to this computer in \/home\/me\/Hosted notes \(synced\)\. mdbase will retry when it can reach the server\./);

  const notReady = presentTakeover({ ...done, mirror_imports: { h: { ...imp, join: {
    state: "waiting", folder: "/home/me/Hosted notes (synced)", reason: "not_found", attempts: 2, cut_over: false
  } } } });
  assert.match(notReady.notices[0], /mdbase will retry once this collection has finished moving\./);

  const syncing = presentTakeover({ ...done, mirror_imports: { h: { ...imp, registered: true, name: "Hosted notes", join: {
    state: "joined", folder: "/home/me/Hosted notes (synced)", reason: "unexpected_status", cut_over: false
  } } } });
  assert.match(syncing.notices[0], /^“Hosted notes” syncs again in \/home\/me\/Hosted notes \(synced\)\. 3 edits .* are added once it has caught up\. mdbase will retry once this collection has finished moving\. The old folder \/home\/me\/Hosted notes is kept as it was\.$/);

  const removed = presentTakeover({ ...done, mirror_imports: { h: { ...imp, join: { state: "joined", folder: "/x" } } } });
  assert.deepEqual(removed.notices, []);
  assert.match(removed.incidents[0], /You removed “Hosted notes” from this computer, so 3 edits .* still in \/home\/me\/Hosted notes\./);

  const imported = presentTakeover({ ...done, mirror_imports: { h: {
    ...imp, applied: 1, held: 1, waiting: 0, complete: true, registered: true, name: "Hosted",
    recovered: [{ path: "d.md", reason: "not_text", file: "/home/me/profile/legacy/h/mirror/bytes/abcd" }]
  } } });
  assert.equal(imported.tone, "attention");
  assert.deepEqual(imported.notices, []);
  assert.match(imported.incidents[0], /1 unsent edit in “Hosted” conflict/);
  assert.match(imported.incidents[1], /d\.md.*not a text file.*profile\/legacy\/h\/mirror\/bytes\/abcd/);

  const clean = presentTakeover({ ...done, mirror_imports: { h: { ...imp, applied: 3, waiting: 0, complete: true, registered: true } } });
  assert.equal(clean.visible, false);

  const failed = presentTakeover({ ...base, record: { state: "postponed", collections: { a: { state: "postponed", reason: "mirror_capture_failed" } } } });
  assert.match(failed.title, /could not be saved/);
  assert.equal(failed.offerStopMirrors, false);
});
