import assert from "node:assert/strict";
import test from "node:test";
import { retainCollections } from "../src/renderer/snapshot.mts";

test("unchanged IPC data retains the list and changed rows leave other cards alone", () => {
  const first = { id: "first", name: "Notes", notices: [] };
  const second = { id: "second", name: "Diary", notices: [] };
  const initial = [first, second];
  assert.equal(retainCollections(initial, structuredClone(initial)), initial);
  const renamed = { ...first, name: "Shared notes" };
  const current = retainCollections(initial, structuredClone([second, renamed]));
  assert.deepEqual(current, [second, renamed]);
  assert.equal(current[0], second);
  assert.notEqual(current[1], first);
  assert.deepEqual(retainCollections(current, [renamed]), [renamed]);
});
