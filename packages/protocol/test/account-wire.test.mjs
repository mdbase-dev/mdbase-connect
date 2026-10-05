import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NEXT_ACCOUNT_CAPABILITY, RELAY_CAPABILITIES, RELAY_REQUIRED_CAPABILITIES } from "../dist/index.js";

test("account identity is optional only for legacy shape, with an exact UUID property and no broad schema relaxation", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/connect-protocol.v1.schema.json", import.meta.url), "utf8"));
  const grant = schema.$defs.grantPolicy;
  assert.deepEqual(grant.properties.account_id, { $ref: "#/$defs/uuid" });
  assert.equal(grant.additionalProperties, false);
  assert.equal(grant.required.includes("account_id"), false);
  assert.equal(NEXT_ACCOUNT_CAPABILITY, "next_account_v1");
  assert.equal(RELAY_CAPABILITIES.includes(NEXT_ACCOUNT_CAPABILITY), false);
  assert.equal(RELAY_REQUIRED_CAPABILITIES.includes(NEXT_ACCOUNT_CAPABILITY), false);
});
