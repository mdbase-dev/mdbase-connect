import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const override = resolve(import.meta.dirname, "../../test/upgrade/rollback-tag-identity.sh");

test("workflow identity override accepts only an annotated origin tag on the pinned commit", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rollback-tag-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("commit", "--allow-empty", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  git("remote", "add", "origin", dir);
  git("tag", "-a", "v1.0.0", "-m", "fixture");
  git("tag", "v1.0.1");
  const verify = (release, revision) => spawnSync("bash", ["-c", 'source "$1"; upgrade_verify_previous_release "$2"', "bash", override, dir], {
    env: { ...process.env, MDBASE_CONNECT_PREVIOUS_RELEASE: release, MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT: revision }, encoding: "utf8"
  });
  const valid = verify("v1.0.0", commit);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /GitHub Release metadata not checked/);
  assert.notEqual(verify("v1.0.1", commit).status, 0);
  assert.notEqual(verify("v1.0.0", "0".repeat(40)).status, 0);
  assert.notEqual(verify("v1.0.2", commit).status, 0);
  assert.notEqual(verify("bad", commit).status, 0);
});
