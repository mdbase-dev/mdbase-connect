import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("fresh issuance advertisements are generated from strict artifact policy in both languages", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "issuance-generator-"));
  try {
    for (const path of ["scripts/generate-application-capabilities.mjs", "config/application-issuance-policy.json",
      ...["application-capability-catalog.v1.json", "application-capability-catalog.v2.json", "operation-catalog.v1.json", "mdbase-app.schema.json"].map(name => `packages/protocol/schemas/${name}`)]) {
      mkdirSync(dirname(resolve(temp, path)), { recursive: true });
      copyFileSync(resolve(root, path), resolve(temp, path));
    }
    mkdirSync(resolve(temp, "packages/protocol/src"), { recursive: true });
    mkdirSync(resolve(temp, "crates/connect-protocol/src"), { recursive: true });
    const policyPath = resolve(temp, "config/application-issuance-policy.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    for (const [phase, versions, valid] of [["compatibility-prelude", [1], true], ["v2-enablement", [1, 2], true],
      ["compatibility-prelude", [1, 2], false], ["v2-enablement", [1], false], ["unknown", [1, 2], false], ["v2-enablement", [2], false]]) {
      writeFileSync(policyPath, JSON.stringify({ ...policy, phase, fresh_semantic_versions: versions }));
      const result = spawnSync(process.execPath, [resolve(temp, "scripts/generate-application-capabilities.mjs")]);
      assert.equal(result.status === 0, valid, `${phase}/${versions}: ${result.stderr}`);
      if (!valid) continue;
      for (const file of ["packages/protocol/src/capabilities.ts", "crates/connect-protocol/src/application_capabilities_generated.rs"]) {
        const source = readFileSync(resolve(temp, file), "utf8");
        const list = source.split("FRESH_APPLICATION_AUTHORIZATION_CAPABILITIES")[1].split(";")[0];
        assert.equal(list.includes('"application-authorization-v2-issuance"'), versions.includes(2));
      }
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
