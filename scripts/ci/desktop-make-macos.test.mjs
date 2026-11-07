import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function make(outcomes) {
  const bin = mkdtempSync(join(tmpdir(), "desktop-make-"));
  const calls = join(bin, "calls");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash
echo call >> "${calls}"
outcome="$(sed -n "$(wc -l < "${calls}")p" "${join(bin, "outcomes")}")"
[ "$outcome" = ok ] && exit 0
echo "$outcome"
exit 1
`);
  chmodSync(join(bin, "pnpm"), 0o755);
  writeFileSync(join(bin, "outcomes"), `${outcomes.join("\n")}\n`);
  const result = spawnSync("bash", ["scripts/ci/desktop-make-macos.sh"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DESKTOP_MAKE_RETRY_SECONDS: "0" },
    encoding: "utf8",
  });
  return { status: result.status, calls: readFileSync(calls, "utf8").trim().split("\n").length };
}

const staple = "Error: Failed to staple your application with code: 68";

test("a stapling failure packages again", () => {
  assert.deepEqual(make([staple, "ok"]), { status: 0, calls: 2 });
});

test("an unsigned app packages again", () => {
  assert.deepEqual(make(["Error: Failed to codesign your application with code: 1", "ok"]), { status: 0, calls: 2 });
});

test("stapling stops failing the job after three attempts", () => {
  assert.deepEqual(make([staple, staple, staple, "ok"]), { status: 1, calls: 3 });
});

test("any other failure is not retried", () => {
  assert.deepEqual(make(["codesign failed", "ok"]), { status: 1, calls: 1 });
});
