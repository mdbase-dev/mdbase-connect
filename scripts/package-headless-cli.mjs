#!/usr/bin/env node

import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const platforms = new Set(["linux", "macos", "windows"]);
const filenameModes = new Set(["standard", "unsigned-preview"]);

function fail(message) {
  throw new Error(message);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000
  });
  if (result.error || result.status !== 0) {
    fail(`Command failed while packaging the headless CLI: ${basename(command)} ${args.join(" ")}`);
  }
}

export async function packageHeadlessCli({
  platform,
  arch,
  version,
  binary,
  outputDirectory,
  filenameMode = "standard",
  repositoryRoot = resolve(import.meta.dirname, "..")
}) {
  if (!platforms.has(platform)) {
    fail(`Unsupported headless platform: ${platform}`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(arch)) {
    fail(`Invalid headless architecture: ${arch}`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
    fail(`Invalid headless release version: ${version}`);
  }
  if (!filenameModes.has(filenameMode)) {
    fail(`Unsupported headless filename mode: ${filenameMode}`);
  }

  const binaryPath = resolve(binary);
  await access(binaryPath, constants.R_OK | constants.X_OK);
  run(binaryPath, ["--help"]);
  run(binaryPath, ["connect", "daemon", "run", "--help"]);

  const outputPath = resolve(outputDirectory);
  await mkdir(outputPath, { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mdbase-headless-release-"));
  try {
    const packageName = `mdbase-${version}-${platform}-${arch}`;
    const packageDirectory = join(temporaryRoot, packageName);
    await mkdir(packageDirectory);
    const executableName = platform === "windows" ? "mdbase.exe" : "mdbase";
    const packagedBinary = join(packageDirectory, executableName);
    await copyFile(binaryPath, packagedBinary);
    await chmod(packagedBinary, 0o755);
    await copyFile(join(repositoryRoot, "LICENSE"), join(packageDirectory, "LICENSE"));
    await copyFile(
      join(repositoryRoot, "docs", "headless.md"),
      join(packageDirectory, "README.md")
    );

    const unsignedSuffix = filenameMode === "unsigned-preview" ? "-UNSIGNED" : "";
    const artifactName = `mdbase-cli-${version}-${platform}-${arch}${unsignedSuffix}.tar.gz`;
    const artifactPath = join(outputPath, artifactName);
    try {
      await access(artifactPath, constants.F_OK);
      fail(`Refusing to overwrite an existing headless artifact: ${artifactName}`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    run("tar", ["-czf", artifactPath, "-C", temporaryRoot, packageName]);
    const artifact = await stat(artifactPath);
    if (!artifact.isFile() || artifact.size === 0) {
      fail("The headless CLI archive is empty.");
    }
    return { artifactName, artifactPath, packageName };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArguments(args) {
  const values = {};
  const known = new Set([
    "platform",
    "arch",
    "version",
    "binary",
    "output-directory",
    "filename-mode"
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      fail("Headless packaging arguments must be --name VALUE pairs.");
    }
    const key = name.slice(2);
    if (!known.has(key) || Object.hasOwn(values, key)) {
      fail(`Unknown or duplicate headless packaging argument: ${name}`);
    }
    values[key] = value;
  }
  const required = ["platform", "arch", "version", "binary", "output-directory"];
  for (const name of required) {
    if (!values[name]) {
      fail(`Missing required argument: --${name}`);
    }
  }
  return {
    platform: values.platform,
    arch: values.arch,
    version: values.version,
    binary: values.binary,
    outputDirectory: values["output-directory"],
    filenameMode: values["filename-mode"] ?? "standard"
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageHeadlessCli(parseArguments(process.argv.slice(2)))
    .then(({ artifactName }) => process.stdout.write(`${artifactName}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
