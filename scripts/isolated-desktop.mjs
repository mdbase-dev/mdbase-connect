#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { availablePort } from "./lib/connect-test-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const userData = resolve(
  process.env.MDBASE_CONNECT_DEV_USER_DATA
    ?? resolve(repoRoot, ".tmp", "desktop-development-profile")
);
const fresh = process.argv.includes("--fresh");
if (fresh) await rm(userData, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
const loopbackPort =
  process.env.MDBASE_CONNECT_LOOPBACK_PORT ?? String(await availablePort());

console.log(`Isolated Electron profile: ${userData}`);
console.log(`Connector loopback port: ${loopbackPort}`);
console.log("The normal mdbase connect profile and credentials will not be read.");

const child = spawn(
  "pnpm",
  ["--filter", "@mdbase/connect-desktop", "start"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      MDBASE_CONNECT_USER_DATA_DIR: userData,
      MDBASE_CONNECT_LOOPBACK_PORT: loopbackPort
    },
    stdio: "inherit"
  }
);
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
