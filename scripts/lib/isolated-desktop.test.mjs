import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { isolatedDesktopConfiguration } from "../isolated-desktop.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

test("the isolated desktop keeps the daemon, Electron and old-connector state inside one profile", () => {
  const binary = "/builds/mdbase";
  const configuration = isolatedDesktopConfiguration({ MDBN_DAEMON_BIN: binary, MDBASE_HOME: "/kept" }, ["--fresh"], () => true);
  const profile = resolve(repoRoot, ".tmp", "desktop-development-profile");
  assert.equal(configuration.fresh, true);
  assert.equal(configuration.profile, profile);
  const env = configuration.childEnvironment;
  for (const key of ["MDBASE_DESKTOP_STATE_DIR", "MDBASE_CONNECT_HOME", "MDBASE_CONNECT_USER_DATA_DIR"]) {
    assert.ok(env[key].startsWith(`${profile}/`), key);
  }
  assert.equal(env.MDBN_DAEMON_BIN, binary);
  assert.equal(env.MDBASE_SECRET_BACKEND, "insecure-test-file");
  assert.equal(env.MDBASE_CONNECT_REGISTER_DEEP_LINKS, "0");
});

test("the isolated desktop refuses to start without an absolute daemon build", () => {
  for (const MDBN_DAEMON_BIN of [undefined, "target/debug/mdbase", "/missing/mdbase"]) {
    assert.throws(
      () => isolatedDesktopConfiguration({ MDBN_DAEMON_BIN }, [], (path) => path !== "/missing/mdbase"),
      /MDBN_DAEMON_BIN/
    );
  }
});
