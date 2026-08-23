import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  isolatedDesktopConfiguration,
  stagingDesktop
} from "../isolated-desktop.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

test("the staging desktop uses an exact persistent profile and loopback port", async () => {
  const configuration = await isolatedDesktopConfiguration({}, ["--staging"], async () => {
    throw new Error("the staging port must not be dynamically allocated");
  });

  const userData = resolve(repoRoot, ".tmp", stagingDesktop.profileDirectory);
  assert.equal(configuration.staging, true);
  assert.equal(configuration.userData, userData);
  assert.equal(configuration.connectHome, resolve(userData, "connect-home"));
  assert.equal(configuration.loopbackPort, stagingDesktop.loopbackPort);
  assert.equal(configuration.childEnvironment.MDBASE_CONNECT_HOME, configuration.connectHome);
  assert.equal(configuration.childEnvironment.MDBASE_CONNECT_USER_DATA_DIR, userData);
  assert.equal(configuration.childEnvironment.MDBASE_CONNECT_LOOPBACK_PORT, "28486");
  assert.equal(configuration.childEnvironment.MDBASE_CONNECT_REGISTER_DEEP_LINKS, "0");
  assert.equal(
    configuration.childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL,
    stagingDesktop.serverUrl
  );
  assert.equal(configuration.childEnvironment.MDBASE_EDITOR_URL, stagingDesktop.editorUrl);
});

test("ordinary isolated desktops separate Electron and daemon state", async () => {
  const userData = resolve(repoRoot, ".tmp", "custom-desktop-profile");
  const configuration = await isolatedDesktopConfiguration(
    { MDBASE_CONNECT_DEV_USER_DATA: userData },
    [],
    async () => 31_245
  );

  assert.equal(configuration.staging, false);
  assert.equal(configuration.userData, userData);
  assert.equal(configuration.connectHome, resolve(userData, "connect-home"));
  assert.equal(configuration.loopbackPort, "31245");
  assert.equal(configuration.childEnvironment.MDBASE_CONNECT_HOME, configuration.connectHome);
  assert.equal(configuration.childEnvironment.MDBASE_CONNECT_REGISTER_DEEP_LINKS, "0");
  assert.equal(
    configuration.childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL,
    undefined
  );
});

test("explicit development overrides remain available without reading production state", async () => {
  const userData = resolve(repoRoot, ".tmp", "named-electron");
  const connectHome = resolve(repoRoot, ".tmp", "named-connector");
  const configuration = await isolatedDesktopConfiguration({
    MDBASE_CONNECT_DEV_USER_DATA: userData,
    MDBASE_CONNECT_DEV_HOME: connectHome,
    MDBASE_CONNECT_LOOPBACK_PORT: "29486",
    MDBASE_CONNECT_REGISTER_DEEP_LINKS: "1"
  }, ["--staging"], async () => 1);

  assert.equal(configuration.userData, userData);
  assert.equal(configuration.connectHome, connectHome);
  assert.equal(configuration.loopbackPort, "29486");
  assert.equal(configuration.childEnvironment.MDBASE_CONNECT_HOME, connectHome);
  assert.equal(configuration.childEnvironment.MDBASE_CONNECT_REGISTER_DEEP_LINKS, "1");
});

test("registry-provided environments configure Electron without staging-only flags", async () => {
  const configuration = await isolatedDesktopConfiguration({
    MDBASE_ENV: "lab",
    MDBASE_CONNECT_URL: "https://mdbase-connect-lab.onrender.com",
    MDBASE_EDITOR_URL: "https://candidate-b.mdbase-editor.pages.dev",
    MDBASE_CONNECT_LOOPBACK_PORT: "28487"
  }, [], async () => 1);

  assert.equal(configuration.namedEnvironment, "lab");
  assert.equal(configuration.loopbackPort, "28487");
  assert.equal(
    configuration.childEnvironment.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL,
    "https://mdbase-connect-lab.onrender.com"
  );
  assert.equal(
    configuration.childEnvironment.MDBASE_EDITOR_URL,
    "https://candidate-b.mdbase-editor.pages.dev"
  );
});

test("named environments reject incomplete or conflicting endpoint pairs", async () => {
  await assert.rejects(
    isolatedDesktopConfiguration({
      MDBASE_ENV: "lab",
      MDBASE_CONNECT_URL: "https://mdbase-connect-lab.onrender.com"
    }, [], async () => 1),
    /require both Connect and editor URLs/
  );
  await assert.rejects(
    isolatedDesktopConfiguration({ MDBASE_ENV: "production" }, [], async () => 1),
    /require explicit Connect and editor URLs/
  );
  await assert.rejects(
    isolatedDesktopConfiguration({
      MDBASE_CONNECT_URL: "https://connect.mdbase.dev",
      VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL: "https://connect-staging.mdbase.dev",
      MDBASE_EDITOR_URL: "https://editor.mdbase.dev"
    }, [], async () => 1),
    /server targets must match/
  );
});

test("staging flags reject endpoint overrides from another environment", async () => {
  await assert.rejects(
    isolatedDesktopConfiguration({
      MDBASE_CONNECT_URL: "https://connect.mdbase.dev",
      MDBASE_EDITOR_URL: "https://editor.mdbase.dev"
    }, ["--staging"], async () => 1),
    /requires the staging Connect service/
  );
});
