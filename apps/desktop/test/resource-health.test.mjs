import assert from "node:assert/strict";
import test from "node:test";
import { refreshResources, presentResourceFailures, retainOfflineInventory } from "../src/renderer/resource-health.mts";

test("partial refresh preserves failed resources and updates independent successes", async () => {
  let collections = ["known"];
  let activity = ["old"];
  const failures = await refreshResources({
    collections: async () => { throw new Error("offline"); },
    activity: async () => { activity = ["new"]; }
  });
  assert.deepEqual(collections, ["known"]);
  assert.deepEqual(activity, ["new"]);
  assert.deepEqual(failures, { collections: "offline" });
  assert.match(presentResourceFailures(failures), /collections.*Last-known/);
  assert.equal(presentResourceFailures(await refreshResources({ collections: async () => { collections = ["restored"]; } })), null);
  assert.deepEqual(collections, ["restored"]);
});

test("one runtime failure masks cascading resource symptoms without losing scope", () => {
  const failures = { connector: "Restart the connector.", collections: "socket closed", mirrors: "socket closed" };
  assert.equal(presentResourceFailures(failures), "Restart the connector. Last-known information is shown; it may be out of date.");
  assert.equal(Object.keys(failures).length, 3);
});

test("an offline empty inventory retains last-known records until authoritative success", () => {
  const previous = { online: true, grants: ["known-grant"], collections: ["known-collection"] };
  const offline = { online: false, grants: [], collections: [] };
  assert.deepEqual(retainOfflineInventory(previous, offline), { ...previous, online: false });
  const confirmedEmpty = { ...offline, online: true };
  assert.equal(retainOfflineInventory(previous, confirmedEmpty), confirmedEmpty);
});
