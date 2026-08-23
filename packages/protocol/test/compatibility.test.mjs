import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizationContractRequirements,
  COLLABORATION_CONTRACT_VERSION,
  CONNECT_CONTRACT_SUPPORT,
  supportsContractRequirements
} from "../dist/index.js";

test("collaboration is negotiated independently from ordinary operations", () => {
  const ordinary = authorizationContractRequirements(["read"]);
  assert.equal(supportsContractRequirements(ordinary, CONNECT_CONTRACT_SUPPORT, false), true);

  const collaborative = authorizationContractRequirements(
    ["read"],
    undefined,
    [],
    COLLABORATION_CONTRACT_VERSION
  );
  assert.deepEqual(collaborative, {
    ...ordinary,
    collaboration: 1
  });
  assert.equal(
    supportsContractRequirements(collaborative, CONNECT_CONTRACT_SUPPORT, false),
    false
  );
  assert.equal(
    supportsContractRequirements(collaborative, {
      ...CONNECT_CONTRACT_SUPPORT,
      collaboration: [COLLABORATION_CONTRACT_VERSION]
    }, false),
    true
  );
});
