import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the hosted-provider image enables privacy-safe metrics by default", async () => {
  const dockerfile = await readFile("deploy/docker/Dockerfile.hosted-provider", "utf8");
  const rustLog = dockerfile.match(/RUST_LOG=([^ \\\n]+)/)?.[1];

  assert.ok(rustLog, "the hosted-provider image must define RUST_LOG");
  assert.match(
    rustLog,
    /(?:^|,)mdbase_connect::metrics=(?:info|debug|trace)(?:,|$)/,
    "the hosted-provider image must not filter out release-gating privacy-safe metrics"
  );
});
