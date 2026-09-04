import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APPLICATION_CAPABILITY_CONTRACT_VERSION,
  APPLICATION_CAPABILITY_DEFINITIONS,
  APPLICATION_SETUP_OPERATIONS,
  applicationOperationSelectionIsAtomic,
  operationsForApplicationCapabilities
} from "../dist/capabilities.js";

const catalog = JSON.parse(readFileSync(
  new URL("../schemas/application-capability-catalog.v2.json", import.meta.url),
  "utf8"
));

test("the generated application capability contract matches its canonical catalog", () => {
  assert.equal(APPLICATION_CAPABILITY_CONTRACT_VERSION, 2);
  assert.deepEqual(
    Object.entries(APPLICATION_CAPABILITY_DEFINITIONS),
    catalog.capabilities.map(({ id, operations }) => [id, operations])
  );
  assert.deepEqual(
    [...APPLICATION_SETUP_OPERATIONS],
    catalog.structured_authorities.application_setup
  );
});

test("application capabilities compile only complete atomic groups", () => {
  assert.deepEqual(
    operationsForApplicationCapabilities({
      contract_version: 2,
      required: ["records.edit"],
      optional: ["records.delete"]
    }, { includeOptional: false }),
    ["update", "rename"]
  );
  const requirements = {
    contract_version: 2,
    required: ["records.edit"],
    optional: ["records.delete"]
  };
  assert.deepEqual(
    operationsForApplicationCapabilities(requirements),
    ["update", "rename", "delete"]
  );
  assert.equal(
    applicationOperationSelectionIsAtomic(requirements, ["update", "rename"]),
    true
  );
  assert.equal(
    applicationOperationSelectionIsAtomic(requirements, ["update"]),
    false
  );
  assert.equal(
    applicationOperationSelectionIsAtomic(requirements, ["update", "rename", "delete"]),
    true
  );
  assert.equal(
    applicationOperationSelectionIsAtomic(requirements, ["update", "rename", "create"]),
    false
  );
});
