#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availablePort } from "./lib/connect-test-environment.mjs";
import {
  managedEnvironments,
  normalizedEndpointOrigin
} from "./lib/managed-environments.mjs";
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
  const requestedEnvironment = environment.MDBASE_ENV?.trim();
  if (staging && requestedEnvironment && requestedEnvironment !== "staging") {
    throw new Error("The staging flag cannot be combined with another MDBASE_ENV.");
  }
  const namedEnvironment = staging
    ? "staging"
    : requestedEnvironment || "development";
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(namedEnvironment)) {
    throw new Error("MDBASE_ENV must be a lowercase environment identifier.");
  }
  const profileDirectory = staging
    ? stagingDesktop.profileDirectory
    : `desktop-${namedEnvironment}-profile`;
  const userData = resolve(
    environment.MDBASE_CONNECT_DEV_USER_DATA
      ?? resolve(repoRoot, ".tmp", profileDirectory)
  );
  const connectHome = resolve(
    environment.MDBASE_CONNECT_DEV_HOME ?? resolve(userData, "connect-home")
  );
  const loopbackPort = environment.MDBASE_CONNECT_LOOPBACK_PORT
    ?? (staging ? stagingDesktop.loopbackPort : String(await allocatePort()));
  if (!/^[1-9][0-9]{0,4}$/u.test(String(loopbackPort))) {
    throw new Error("MDBASE_CONNECT_LOOPBACK_PORT must be a valid TCP port.");
  }
  const numericLoopbackPort = Number(loopbackPort);
  if (numericLoopbackPort > 65_535) {
    throw new Error("MDBASE_CONNECT_LOOPBACK_PORT must be a valid TCP port.");
  }
  const childEnvironment = {
    ...environment,
    VITE_MDBASE_ENV: namedEnvironment,
    MDBASE_CONNECT_HOME: connectHome,
    MDBASE_CONNECT_USER_DATA_DIR: userData,
    MDBASE_CONNECT_LOOPBACK_PORT: String(numericLoopbackPort),
    MDBASE_CONNECT_REGISTER_DEEP_LINKS:
      environment.MDBASE_CONNECT_REGISTER_DEEP_LINKS ?? "0"
  };
  const serverTargets = [
    environment.MDBASE_CONNECT_URL,
    environment.MDBASE_CONNECT_SERVER_URL,
    environment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL
  ].map((value) => value?.trim()).filter(Boolean);
  const normalizedServerTargets = serverTargets.map((value) =>
    normalizedEndpointOrigin(value, "The isolated desktop Connect server")
  );
  const distinctServerTargets = [...new Set(normalizedServerTargets)];
  if (distinctServerTargets.length > 1) {
    throw new Error("Isolated desktop Connect server targets must match.");
  }
  const configuredServer = distinctServerTargets[0];
  const configuredEditor = environment.MDBASE_EDITOR_URL?.trim()
    ? normalizedEndpointOrigin(
        environment.MDBASE_EDITOR_URL,
        "The isolated desktop editor"
      )
    : undefined;
  if (Boolean(configuredServer) !== Boolean(configuredEditor)) {
    throw new Error(
      "Named isolated desktop environments require both Connect and editor URLs."
    );
  }

  const managed = managedEnvironments[namedEnvironment];
  if (staging) {
    if (configuredServer && configuredServer !== managed.connectOrigin) {
      throw new Error("The staging desktop requires the staging Connect service.");
    }
    if (configuredEditor && configuredEditor !== managed.editorOrigin) {
      throw new Error("The staging desktop requires the staging editor.");
    }
    childEnvironment.MDBASE_EDITOR_URL = `${managed.editorOrigin}/`;
    childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL =
      managed.connectOrigin;
  } else if (managed) {
    if (!configuredServer || !configuredEditor) {
      throw new Error(
        `${namedEnvironment} isolated desktops require explicit Connect and editor URLs.`
      );
    }
    if (configuredServer !== managed.connectOrigin) {
      throw new Error(
        `The ${namedEnvironment} desktop requires the ${namedEnvironment} Connect service.`
      );
    }
    if (configuredEditor !== managed.editorOrigin) {
      throw new Error(
        `The ${namedEnvironment} desktop requires the ${namedEnvironment} editor.`
      );
    }
    childEnvironment.MDBASE_EDITOR_URL = `${managed.editorOrigin}/`;
    childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL =
      managed.connectOrigin;
  } else if (configuredServer && configuredEditor) {
    childEnvironment.MDBASE_EDITOR_URL = `${configuredEditor}/`;
    childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL = configuredServer;
  }
  return {
    staging,
    namedEnvironment,
    fresh: arguments_.includes("--fresh"),
    userData,
    connectHome,
    loopbackPort: String(numericLoopbackPort),
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
  if (configuration.childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL) {
    console.log(
      `${configuration.namedEnvironment} Connect service: `
      + configuration.childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL
    );
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
