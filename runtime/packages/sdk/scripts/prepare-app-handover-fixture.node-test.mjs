import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureBytes } from "./prepare-app-handover-fixture.mjs";

test("carries exactly one whole original public fixture, never a missing or ambiguous one", () => {
  const line = "APP_HANDOVER_FIXTURE_HEX=aabb00";
  assert.deepEqual(fixtureBytes(`running 1 test\n${line}\ntest result: ok\n`), Buffer.from([0xaa, 0xbb, 0]));
  assert.throws(() => fixtureBytes("test result: ok\n"), /exactly one/);
  assert.throws(() => fixtureBytes(`${line}\n${line}\n`), /exactly one/);
  assert.throws(() => fixtureBytes(`${line}\nAPP_HANDOVER_FIXTURE_HEX=not-hex\n`), /exactly one/);
  assert.throws(() => fixtureBytes("APP_HANDOVER_FIXTURE_HEX=a\n"), /whole fixture bytes/);
});
