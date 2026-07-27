import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import test from "node:test";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("release scripts emit a deterministic, digest-bound platform manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-release-"));
  const artifact = "mdbase-connect-0.1.0-beta.9-macos-arm64.zip";
  const bytes = Buffer.from("signed application archive");
  await writeFile(join(directory, artifact), bytes);
  await writeFile(join(directory, `${artifact}.sigstore.json`), "{}");
  await execFile(
    process.execPath,
    [
      "scripts/write-update-input.mjs",
      "--directory",
      directory,
      "--platform",
      "macos",
      "--arch",
      "arm64",
      "--mode",
      "automatic",
      "--action-url",
      "$RELEASE_URL",
      "--artifact",
      artifact
    ],
    { cwd: repositoryRoot }
  );
  const output = join(directory, "manifest.json");
  await execFile(
    process.execPath,
    [
      "scripts/generate-update-manifest.mjs",
      "--directory",
      directory,
      "--output",
      output,
      "--version",
      "0.1.0-beta.9",
      "--repository",
      "mdbase-dev/mdbase-connect",
      "--rollout",
      "25",
      "--blocked-versions",
      "0.1.0-beta.7,0.1.0-beta.8",
      "--published-at",
      "2026-07-28T00:00:00.000Z"
    ],
    { cwd: repositoryRoot }
  );
  const manifest = JSON.parse(await readFile(output, "utf8"));
  const target = manifest.targets["darwin-arm64"];
  assert.equal(manifest.rollout.percentage, 25);
  assert.deepEqual(manifest.blocked_versions, ["0.1.0-beta.7", "0.1.0-beta.8"]);
  assert.equal(target.mode, "automatic");
  assert.equal(target.artifacts[0].size, bytes.length);
  assert.equal(
    target.artifacts[0].sha256,
    createHash("sha256").update(bytes).digest("hex")
  );
  assert.match(target.artifacts[0].sigstore_url, /\.zip\.sigstore\.json$/);
});

test("release input creation rejects missing provenance bundles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-release-"));
  await writeFile(join(directory, "update.zip"), "archive");
  await assert.rejects(
    execFile(
      process.execPath,
      [
        "scripts/write-update-input.mjs",
        "--directory",
        directory,
        "--platform",
        "macos",
        "--arch",
        "arm64",
        "--mode",
        "automatic",
        "--action-url",
        "$RELEASE_URL",
        "--artifact",
        "update.zip"
      ],
      { cwd: repositoryRoot }
    )
  );
});

test("release manifest generation rejects duplicate targets and invalid rollout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-release-"));
  await writeFile(
    join(directory, "update-input-macos-arm64.json"),
    JSON.stringify({
      schema_version: 1,
      platform: "macos",
      arch: "arm64",
      mode: "store",
      action_url: "https://example.com/store",
      artifacts: []
    })
  );
  await assert.rejects(
    execFile(
      process.execPath,
      [
        "scripts/generate-update-manifest.mjs",
        "--directory",
        directory,
        "--output",
        join(directory, "manifest.json"),
        "--version",
        "0.1.0-beta.9",
        "--repository",
        "mdbase-dev/mdbase-connect",
        "--rollout",
        "101"
      ],
      { cwd: repositoryRoot }
    ),
    /Rollout percentage/
  );
});

test("release manifest generation rejects duplicate artifact names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-release-"));
  await writeFile(join(directory, "update.zip"), "archive");
  await writeFile(join(directory, "update.zip.sigstore.json"), "{}");
  await writeFile(
    join(directory, "update-input-macos-arm64.json"),
    JSON.stringify({
      schema_version: 1,
      platform: "macos",
      arch: "arm64",
      mode: "automatic",
      action_url: "https://example.com/release",
      artifacts: ["update.zip", "update.zip"]
    })
  );
  await assert.rejects(
    execFile(
      process.execPath,
      [
        "scripts/generate-update-manifest.mjs",
        "--directory",
        directory,
        "--output",
        join(directory, "manifest.json"),
        "--version",
        "0.1.0-beta.9",
        "--repository",
        "mdbase-dev/mdbase-connect",
        "--rollout",
        "100"
      ],
      { cwd: repositoryRoot }
    ),
    /duplicate artifact names/
  );
});

test("release manifest generation cannot withdraw its own target version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-release-"));
  await writeFile(
    join(directory, "update-input-windows-x64.json"),
    JSON.stringify({
      schema_version: 1,
      platform: "windows",
      arch: "x64",
      mode: "store",
      action_url: "https://apps.microsoft.com/detail/example",
      artifacts: []
    })
  );
  await assert.rejects(
    execFile(
      process.execPath,
      [
        "scripts/generate-update-manifest.mjs",
        "--directory",
        directory,
        "--output",
        join(directory, "manifest.json"),
        "--version",
        "0.1.0-beta.9",
        "--repository",
        "mdbase-dev/mdbase-connect",
        "--rollout",
        "100",
        "--blocked-versions",
        "0.1.0-beta.9"
      ],
      { cwd: repositoryRoot }
    ),
    /cannot block its own/
  );
});
