import assert from "node:assert/strict";
import test from "node:test";

import {
  findUnbootstrappedPackages,
  packageMetadataUrl,
} from "../check-npm-package-bootstrap.mjs";

test("encodes scoped package metadata URLs", () => {
  assert.equal(
    packageMetadataUrl(
      "https://registry.example.test/custom",
      "@mdbase-dev/connect-testing",
    ),
    "https://registry.example.test/custom/%40mdbase-dev%2Fconnect-testing",
  );
});

test("reports every public package absent from the registry", async () => {
  const requested = [];
  const missing = await findUnbootstrappedPackages({
    registry: "https://registry.example.test/",
    fetchImpl: async (url) => {
      requested.push(url);
      return {
        ok: !url.includes("connect-testing"),
        status: url.includes("connect-testing") ? 404 : 200,
      };
    },
  });

  assert.deepEqual(missing, ["@mdbase-dev/connect-testing"]);
  assert.equal(requested.length, 7);
});

test("fails closed when the registry cannot answer authoritatively", async () => {
  await assert.rejects(
    findUnbootstrappedPackages({
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /npm registry lookup .* HTTP 503/,
  );
});
