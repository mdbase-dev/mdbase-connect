#!/usr/bin/env node

// Run the desktop app against an mdbn-daemon build in an isolated development profile.
// Nothing outside the profile directory is read or written: the daemon gets its own
// `--state-dir` (no OS service), an empty old-connector home and a test secret store.
//
//   MDBN_DAEMON_BIN=<abs mdbase-next build of `mdbase`> pnpm dev:desktop:isolated [--fresh]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runIsolatedDesktop(process.env, process.argv.slice(2));
}

export function isolatedDesktopConfiguration(environment, arguments_, exists = existsSync) {
  const binary = environment.MDBN_DAEMON_BIN;
  if (!binary || !isAbsolute(binary) || !exists(binary)) {
    throw new Error("Set MDBN_DAEMON_BIN to the absolute path of an mdbn-daemon `mdbase` build.");
  }
  const profile = resolve(
    environment.MDBASE_CONNECT_DEV_USER_DATA ?? resolve(repoRoot, ".tmp", "desktop-development-profile")
  );
  return {
    fresh: arguments_.includes("--fresh"),
    profile,
    childEnvironment: {
      ...environment,
      MDBN_DAEMON_BIN: binary,
      MDBASE_DESKTOP_STATE_DIR: join(profile, "daemon"),
      MDBASE_CONNECT_HOME: join(profile, "no-connect"),
      MDBASE_CONNECT_USER_DATA_DIR: join(profile, "electron"),
      MDBASE_ENV: "test",
      MDBASE_SECRET_BACKEND: "insecure-test-file",
      MDBASE_CONNECT_REGISTER_DEEP_LINKS: environment.MDBASE_CONNECT_REGISTER_DEEP_LINKS ?? "0"
    }
  };
}

export async function runIsolatedDesktop(environment, arguments_, dependencies = { spawn }) {
  const configuration = isolatedDesktopConfiguration(environment, arguments_);
  if (configuration.fresh) await rm(configuration.profile, { recursive: true, force: true });
  await mkdir(configuration.profile, { recursive: true });
  console.log(`Isolated desktop profile: ${configuration.profile}`);
  console.log("The installed mdbase service, keychain and normal profile are not used.");
  const child = dependencies.spawn("pnpm", ["--filter", "@mdbase/connect-desktop", "start"], {
    cwd: repoRoot,
    env: configuration.childEnvironment,
    stdio: "inherit"
  });
  child.once("error", (error) => {
    throw error;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
