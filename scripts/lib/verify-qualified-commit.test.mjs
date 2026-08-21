import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = join(repositoryRoot, "scripts/ci/verify-qualified-commit");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

test("requires a full qualification bound to the exact checkout", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "qualified-commit-"));
  await mkdir(join(fixture, ".github/workflows"), { recursive: true });
  await mkdir(join(fixture, "deploy/docker"), { recursive: true });
  await mkdir(join(fixture, "bin"), { recursive: true });
  await cp(
    join(repositoryRoot, ".github/workflows/server-ci.yml"),
    join(fixture, ".github/workflows/server-ci.yml"),
  );
  await writeFile(join(fixture, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(fixture, "deploy/docker/Cargo.lock.hosted-provider"), "lock\n");
  await writeFile(
    join(fixture, "deploy/docker/mdbase-rs-revision"),
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
  );
  run("git", ["init", "--quiet"], { cwd: fixture });
  run("git", ["config", "user.email", "ci@example.test"], { cwd: fixture });
  run("git", ["config", "user.name", "CI"], { cwd: fixture });
  run("git", ["add", "."], { cwd: fixture });
  run("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });
  const commit = run("git", ["rev-parse", "HEAD"], { cwd: fixture });
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], { cwd: fixture });
  const manifest = join(fixture, "qualification.json");
  await writeFile(
    manifest,
    `${JSON.stringify({
      schema_version: 1,
      qualification: "full",
      commit,
      tree,
      event: "push",
      run_id: "321",
      upstream_run_id: null,
      inputs: {
        pnpm_lock_sha256: await sha256(join(fixture, "pnpm-lock.yaml")),
        cargo_lock_sha256: await sha256(
          join(fixture, "deploy/docker/Cargo.lock.hosted-provider"),
        ),
        mdbase_rs_revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workflow_sha256: await sha256(join(fixture, ".github/workflows/server-ci.yml")),
      },
    })}\n`,
  );
  const fakeGh = join(fixture, "bin/gh");
  await writeFile(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == api && $* == *actions/workflows/server-ci.yml/runs* ]]; then
  printf '{"workflow_runs":[{"id":321,"head_sha":"%s","event":"push","conclusion":"success","run_number":1}]}\\n' "$TEST_COMMIT"
elif [[ $1 == api && $* == *actions/runs/321* ]]; then
  printf '{"head_sha":"%s","event":"push","status":"completed","conclusion":"success","path":".github/workflows/server-ci.yml"}\\n' "$TEST_COMMIT"
elif [[ $1 == run && $2 == download ]]; then
  while (($#)); do
    [[ $1 != --dir ]] || { cp "$TEST_MANIFEST" "$2/qualification.json"; exit 0; }
    shift
  done
  exit 2
else
  exit 2
fi
`,
  );
  await chmod(fakeGh, 0o755);
  const output = join(fixture, "github-output");
  const environment = {
    ...process.env,
    PATH: `${join(fixture, "bin")}:${process.env.PATH}`,
    GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect",
    GITHUB_OUTPUT: output,
    TEST_COMMIT: commit,
    TEST_MANIFEST: manifest,
  };
  const result = spawnSync(verifier, [commit], {
    cwd: fixture,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(output, "utf8"), /artifact_run_id=321/);

  await writeFile(join(fixture, "pnpm-lock.yaml"), "changed\n");
  const mismatched = spawnSync(verifier, [commit], {
    cwd: fixture,
    env: environment,
    encoding: "utf8",
  });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /not bound to this exact checkout/);
});
