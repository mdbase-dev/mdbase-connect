#!/usr/bin/env node

// Stage the mdbn-daemon build the app bundles as `Resources/mdbase-next/`:
// `mdbase[.exe]` plus `VERSION` (the binary's own `--version`). Forge copies the
// staged directory into the package (forge.config.cjs); the app installs it as the
// OS service at launch (src/main/next-daemon.ts).
//
//   MDBN_DAEMON_BIN=<abs path to a runtime/ release build of mdbase> \
//   [MDBN_DAEMON_VERSION=<expected version>] node scripts/stage-daemon.mjs

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STAGED_DAEMON = resolve(import.meta.dirname, "..", "out", "daemon", "mdbase-next");
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const staged = await stageDaemon(process.env);
  process.stdout.write(`Staged mdbase daemon ${staged.version} in ${staged.directory}\n`);
}

export async function stageDaemon(environment, {
  directory = STAGED_DAEMON,
  platform = process.platform,
  version = (binary) => String(execFileSync(binary, ["--version"], { timeout: 10_000 })).trim().split(/\s+/).at(-1)
} = {}) {
  const binary = environment.MDBN_DAEMON_BIN;
  if (!binary || !isAbsolute(binary) || !existsSync(binary)) {
    throw new Error("Set MDBN_DAEMON_BIN to the absolute path of an mdbn-daemon `mdbase` release build.");
  }
  const reported = version(binary);
  if (!reported || !VERSION.test(reported)) throw new Error(`${binary} did not report a valid version.`);
  const expected = environment.MDBN_DAEMON_VERSION;
  if (expected && expected !== reported) {
    throw new Error(`MDBN_DAEMON_BIN is version ${reported}, expected ${expected}.`);
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const target = join(directory, `mdbase${platform === "win32" ? ".exe" : ""}`);
  await copyFile(binary, target);
  if (platform !== "win32") await chmod(target, 0o755);
  await writeFile(join(directory, "VERSION"), `${reported}\n`);
  return { directory, version: reported };
}
