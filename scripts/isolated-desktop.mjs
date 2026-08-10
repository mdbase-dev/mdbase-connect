#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availablePort } from "./lib/connect-test-environment.mjs";
import { stagingEnvironment } from "./lib/staging-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
export const stagingDesktop = Object.freeze({
  serverUrl: stagingEnvironment.connectOrigin,
  editorUrl: `${stagingEnvironment.editorOrigin}/`,
  loopbackPort: String(stagingEnvironment.loopbackPort),
  profileDirectory: "desktop-staging-profile"
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runIsolatedDesktop(process.env, process.argv.slice(2));
}

export async function isolatedDesktopConfiguration(
  environment,
  arguments_,
  allocatePort = availablePort
) {
  const staging = arguments_.includes("--staging");
  const profileDirectory = staging
    ? stagingDesktop.profileDirectory
    : "desktop-development-profile";
  const userData = resolve(
    environment.MDBASE_CONNECT_DEV_USER_DATA
      ?? resolve(repoRoot, ".tmp", profileDirectory)
  );
  const connectHome = resolve(
    environment.MDBASE_CONNECT_DEV_HOME ?? resolve(userData, "connect-home")
  );
  const loopbackPort = environment.MDBASE_CONNECT_LOOPBACK_PORT
    ?? (staging ? stagingDesktop.loopbackPort : String(await allocatePort()));
  const childEnvironment = {
    ...environment,
    MDBASE_CONNECT_HOME: connectHome,
    MDBASE_CONNECT_USER_DATA_DIR: userData,
    MDBASE_CONNECT_LOOPBACK_PORT: loopbackPort,
    MDBASE_CONNECT_REGISTER_DEEP_LINKS:
      environment.MDBASE_CONNECT_REGISTER_DEEP_LINKS ?? "0"
  };
  if (staging) {
    childEnvironment.MDBASE_EDITOR_URL =
      environment.MDBASE_EDITOR_URL ?? stagingDesktop.editorUrl;
    childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL =
      environment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL ?? stagingDesktop.serverUrl;
  }
  return {
    staging,
    fresh: arguments_.includes("--fresh"),
    userData,
    connectHome,
    loopbackPort,
    childEnvironment
  };
}

export async function runIsolatedDesktop(
  environment,
  arguments_,
  dependencies = { allocatePort: availablePort, spawn }
) {
  const configuration = await isolatedDesktopConfiguration(
    environment,
    arguments_,
    dependencies.allocatePort
  );
  if (configuration.fresh) {
    await rm(configuration.userData, { recursive: true, force: true });
  }
  await mkdir(configuration.userData, { recursive: true });

  console.log(`Isolated Electron profile: ${configuration.userData}`);
  console.log(`Isolated connector state: ${configuration.connectHome}`);
  console.log(`Connector loopback port: ${configuration.loopbackPort}`);
  if (configuration.staging) {
    console.log(`Staging Connect service: ${stagingDesktop.serverUrl}`);
  }
  console.log("The normal mdbase connect profile and credentials will not be read.");

  const child = dependencies.spawn(
    "pnpm",
    ["--filter", "@mdbase/connect-desktop", "start"],
    {
      cwd: repoRoot,
      env: configuration.childEnvironment,
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
}
