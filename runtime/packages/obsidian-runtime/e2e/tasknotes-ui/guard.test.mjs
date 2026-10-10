import { it as test } from "vitest";
import assert from "node:assert/strict";
import { validateEnvelope, validatePhysicalRoot } from "./guard.mjs";
const status = { environment: "lab", identity: "verified", connect_origin: "https://connect-lab.mdbase.dev", daemon: { running: true } };
const fixture = { environment: "lab", labOwnsFixture: true, labOwnsProfile: true, label: "[test] synthetic", collectionRegistered: true,
  nativeCollectionReady: true, collection: "00000000-0000-0000-0000-000000000001", stateDir: "/synthetic/owned-daemon-state" };
test("only verified LAB and an explicitly registered, ready, owned fixture pass", () => {
  assert.doesNotThrow(() => validateEnvelope(status, fixture));
  for (const bad of [{ environment: "production" }, { identity: "pending" }, { connect_origin: "https://connect.mdbase.dev" }, { daemon: { running: null } }]) {
    assert.throws(() => validateEnvelope({ ...status, ...bad }, fixture), /lab_preflight/);
  }
});
test("offline sentinel is not entry authority", () => {
  assert.throws(() => validateEnvelope({ ...status, daemon: { running: null } }, fixture), /lab_preflight/);
});
test("missing registration, readiness or profile/fixture ownership denies entry", () => {
  for (const bad of [{ collectionRegistered: false }, { nativeCollectionReady: false }, { labOwnsFixture: false }, { labOwnsProfile: false }, { label: "not a test" }, { collection: "" }, { stateDir: "" }]) {
    assert.throws(() => validateEnvelope(status, { ...fixture, ...bad }), /fixture_scope/);
  }
});
test("physical vault must be exactly this fixture's isolated collection", () => {
  const parent = "/synthetic/obsidian-ui-fixtures", root = parent + "/[test]-run/collection";
  assert.doesNotThrow(() => validatePhysicalRoot(parent, root, root));
  assert.throws(() => validatePhysicalRoot(parent, root, "/synthetic/user-vault"), /wrong_vault/);
  for (const other of ["/synthetic/[test]-escape/collection", parent + "/other/collection", parent + "/[test]-run/nested/collection", parent + "/[test]-run/other"]) {
    assert.throws(() => validatePhysicalRoot(parent, other, other), /fixture_root/);
  }
  assert.throws(() => validatePhysicalRoot("/synthetic/integration-fixtures", "/synthetic/integration-fixtures/[test]-run/collection", "/synthetic/integration-fixtures/[test]-run/collection"), /fixture_root/);
});
