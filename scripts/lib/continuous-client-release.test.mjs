import assert from "node:assert/strict";
import test from "node:test";
import { contractSensitive, nextBetaVersion, proveCompatibility, requireRunning } from "./continuous-client-release.mjs";

test("CI beta allocation advances every published and source version without numeric overflow", () => {
  assert.equal(nextBetaVersion(["0.1.0-beta.9", "0.1.0-beta.152", "0.1.0-beta.101"]), "0.1.0-beta.153");
  assert.equal(nextBetaVersion(["0.0.1-next.0", "0.1.0-beta.152"]), "0.1.0-beta.153");
  assert.equal(nextBetaVersion(["0.1.0-beta.9007199254740999"]), "0.1.0-beta.9007199254741000");
  for (const version of ["0.1.0", "0.2.0-beta.1", "garbage", "0.1.0-beta.01"]) {
    assert.throws(() => nextBetaVersion([version]), /release-owner review/);
  }
});

test("unknown, authorization, transport, trust and policy sources are contract-sensitive", () => {
  for (const path of ["packages/protocol/src/auth.ts", "packages/client/src/grants.ts", "runtime/crates/wire/src/lib.rs",
    "runtime/packages/sdk/src/index.ts", "config/next-trust/production.json", "services/server/src/main.ts",
    "deploy/docker/mdbase-rs-revision", "new-contract/source.ts", "scripts/build-release-trust-bundle.mts",
    "apps/desktop/src/main/main.ts", "apps/editor/src/gateway.ts", "packages/ui/src/button.tsx",
    "packages/sync/src/index.ts", "packages/webhooks/src/index.ts", "packages/pickle/src/index.ts"]) {
    assert.equal(contractSensitive(path), true, path);
  }
  for (const path of ["apps/desktop/assets/icon.png", "apps/editor/src/styles.css", "docs/releasing.md",
    "runtime/crates/wire/tests/protocol.rs", "packages/client/src/grants.test.ts"]) {
    assert.equal(contractSensitive(path), false, path);
  }
});

test("stop switch fails closed on true and invalid values", () => {
  for (const value of [undefined, "", "false"]) requireRunning(value);
  for (const value of ["true", "False", "0", "unknown"]) assert.throws(() => requireRunning(value), /stopped/);
});

test("production ancestry or an exact off-axis diff is required, not version equality", () => {
  const candidate = "a".repeat(40);
  const production = "b".repeat(40);
  const run = (paths, status = 1) => (...args) => {
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") throw Object.assign(new Error("ancestry"), { status });
    if (args[0] === "diff") {
      assert.deepEqual(args.slice(1), ["--no-renames", "--name-only", "-z", production, candidate]);
      return paths.join("\0");
    }
    return "";
  };
  assert.equal(proveCompatibility(candidate, production, () => "").reason, "production-contains-candidate");
  assert.equal(proveCompatibility(candidate, production, run(["apps/editor/src/styles.css"])).reason, "unchanged-contract-axis");
  assert.throws(() => proveCompatibility(candidate, production, run(["apps/desktop/src/main/main.ts"])), /server-facing contract/);
  assert.throws(() => proveCompatibility(candidate, production, run(["packages/protocol/src/auth.ts"])), /server-facing contract/);
  assert.throws(() => proveCompatibility(candidate, production, run([], 128)), /ancestry/);
  assert.throws(() => proveCompatibility("main", production, run([])), /full commit/);
});
