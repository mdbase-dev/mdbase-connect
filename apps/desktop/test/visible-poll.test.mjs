import assert from "node:assert/strict";
import test from "node:test";
import { pollWhileVisible } from "../src/renderer/visible-poll.mts";

/** A document whose visibility the test sets, as Electron does on hide and show. */
function page(visibilityState) {
  const listeners = new Set();
  return {
    visibilityState,
    listeners,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    set(next) {
      this.visibilityState = next;
      for (const listener of [...listeners]) listener();
    }
  };
}

const POLL_MS = 5_000;

test("a visible page polls at once and on every interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const doc = page("visible");
  let calls = 0;
  pollWhileVisible(() => calls++, POLL_MS, doc, globalThis);
  assert.equal(calls, 1);
  t.mock.timers.tick(POLL_MS * 3);
  assert.equal(calls, 4);
});

test("a hidden page makes no calls; showing it polls once at once, then resumes", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const doc = page("visible");
  let calls = 0;
  pollWhileVisible(() => calls++, POLL_MS, doc, globalThis);
  t.mock.timers.tick(POLL_MS);
  assert.equal(calls, 2);

  doc.set("hidden");
  t.mock.timers.tick(POLL_MS * 10);
  assert.equal(calls, 2, "no calls across ten intervals while hidden");

  doc.set("visible");
  assert.equal(calls, 3, "exactly one call on becoming visible");
  t.mock.timers.tick(POLL_MS - 1);
  assert.equal(calls, 3, "the next call waits a whole interval");
  t.mock.timers.tick(1);
  assert.equal(calls, 4);
  t.mock.timers.tick(POLL_MS * 2);
  assert.equal(calls, 6, "polling resumed");
});

test("a page that starts hidden (launched to the tray) makes no calls until shown", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const doc = page("hidden");
  let calls = 0;
  pollWhileVisible(() => calls++, POLL_MS, doc, globalThis);
  t.mock.timers.tick(POLL_MS * 10);
  assert.equal(calls, 0);
  doc.set("visible");
  assert.equal(calls, 1);
  t.mock.timers.tick(POLL_MS);
  assert.equal(calls, 2);
});

test("repeated visibility events while visible do not add calls or intervals", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const doc = page("visible");
  let calls = 0;
  pollWhileVisible(() => calls++, POLL_MS, doc, globalThis);
  doc.set("visible");
  doc.set("visible");
  assert.equal(calls, 1);
  t.mock.timers.tick(POLL_MS);
  assert.equal(calls, 2, "still one interval");
  doc.set("hidden");
  doc.set("hidden");
  t.mock.timers.tick(POLL_MS * 4);
  assert.equal(calls, 2);
});

test("stopping removes the listener and the interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const doc = page("visible");
  let calls = 0;
  const stop = pollWhileVisible(() => calls++, POLL_MS, doc, globalThis);
  stop();
  assert.equal(doc.listeners.size, 0);
  t.mock.timers.tick(POLL_MS * 4);
  doc.set("hidden");
  doc.set("visible");
  assert.equal(calls, 1);
});
