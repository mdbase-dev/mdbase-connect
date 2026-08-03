import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { packageHeadlessCli } from "../package-headless-cli.mjs";

test("packages the verified canonical CLI for each release filename mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "mdbase-headless-test-"));
  const originalWorkingDirectory = process.cwd();
  let changedWorkingDirectory = false;
  try {
    const repositoryRoot = join(root, "repo");
    const outputDirectory = join(root, "output");
    await mkdir(join(repositoryRoot, "docs"), { recursive: true });
    await writeFile(join(repositoryRoot, "LICENSE"), "test license\n");
    await writeFile(join(repositoryRoot, "docs", "headless.md"), "install safely\n");
    let binary;
    if (process.platform === "win32") {
      // Use a real host-native executable on Windows. The adjacent extensionless
      // script lets node accept the CLI's multi-word help invocation without
      // weakening the production packager's native-binary verification.
      await writeFile(join(root, "connect"), `
if (process.argv.slice(2).join(" ") !== "daemon run --help") process.exit(1);
`);
      process.chdir(root);
      changedWorkingDirectory = true;
      binary = process.execPath;
    } else {
      binary = join(root, "mdbase");
      await writeFile(binary, `#!/usr/bin/env bash
case "$*" in
  --help|"connect daemon run --help") exit 0 ;;
  *) exit 1 ;;
esac
`);
      await chmod(binary, 0o755);
    }

    const packaged = await packageHeadlessCli({
      platform: "linux",
      arch: "x64",
      version: "0.1.0-beta.27",
      binary,
      outputDirectory,
      repositoryRoot
    });
    assert.equal(packaged.artifactName, "mdbase-cli-0.1.0-beta.27-linux-x64.tar.gz");
    const listing = spawnSync("tar", ["-tzf", packaged.artifactPath], { encoding: "utf8" });
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /mdbase-0\.1\.0-beta\.27-linux-x64\/mdbase$/m);
    assert.match(listing.stdout, /README\.md$/m);
    assert.match(listing.stdout, /LICENSE$/m);

    const unsigned = await packageHeadlessCli({
      platform: "windows",
      arch: "x64",
      version: "0.1.0-beta.27",
      binary,
      outputDirectory,
      filenameMode: "unsigned-preview",
      repositoryRoot
    });
    assert.equal(
      unsigned.artifactName,
      "mdbase-cli-0.1.0-beta.27-windows-x64-UNSIGNED.tar.gz"
    );
    assert.ok((await readFile(unsigned.artifactPath)).length > 0);
  } finally {
    if (changedWorkingDirectory) process.chdir(originalWorkingDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous or unsupported release identities", async () => {
  await assert.rejects(
    packageHeadlessCli({
      platform: "freebsd",
      arch: "x64",
      version: "0.1.0-beta.27",
      binary: "/missing",
      outputDirectory: "/missing"
    }),
    /Unsupported headless platform/
  );
});
