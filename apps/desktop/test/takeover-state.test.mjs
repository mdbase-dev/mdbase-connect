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
    assert.equal(waiting.title, "Your collections still use mdbase Connect");
    assert.match(waiting.detail, /automatically once your mdbase account is upgraded/);
  }
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
  assert.match(waiting.notices[0], /^3 edits made in “Hosted notes” before the move were not uploaded/);
  assert.match(waiting.notices[0], /when you join/);

  const imported = presentTakeover({ ...done, mirror_imports: { h: {
    ...imp, applied: 1, held: 1, waiting: 0, complete: true, registered: true, name: "Hosted",
    recovered: [{ path: "d.md", reason: "not_text", file: "/home/me/Hosted notes (unsent edits)/d.md" }]
  } } });
  assert.equal(imported.tone, "attention");
  assert.deepEqual(imported.notices, []);
  assert.match(imported.incidents[0], /1 unsent edit in “Hosted” conflict/);
  assert.match(imported.incidents[1], /d\.md.*not a text file.*\(unsent edits\)\/d\.md/);

  const clean = presentTakeover({ ...done, mirror_imports: { h: { ...imp, applied: 3, waiting: 0, complete: true, registered: true } } });
  assert.equal(clean.visible, false);

  const failed = presentTakeover({ ...base, record: { state: "postponed", collections: { a: { state: "postponed", reason: "mirror_capture_failed" } } } });
  assert.match(failed.title, /could not be saved/);
  assert.equal(failed.offerStopMirrors, false);
});
