// Drive a real mdbn-daemon in an isolated profile through the app's control client,
// CLI runner and session (no Electron, no service manager, test secret backend).
//
//   MDBN_DAEMON_BIN=…/mdbase MDBASE_DESKTOP_SMOKE_DIR=<scratch> \
//   MDBASE_ENV=test MDBASE_SECRET_BACKEND=insecure-test-file \
//   node scripts/next-daemon-smoke.mjs
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";

const require = createRequire(import.meta.url);
const { DaemonCli } = require("../dist/main/daemon-cli.js");
const { DaemonSession, healthLabel } = require("../dist/main/daemon-session.js");

const binary = process.env.MDBN_DAEMON_BIN;
const root = process.env.MDBASE_DESKTOP_SMOKE_DIR;
if (!binary || !root || !isAbsolute(root)) throw new Error("Set MDBN_DAEMON_BIN and an absolute MDBASE_DESKTOP_SMOKE_DIR.");
if (process.env.MDBASE_ENV !== "test" || process.env.MDBASE_SECRET_BACKEND !== "insecure-test-file") {
  throw new Error("Refusing to run without MDBASE_ENV=test and the test secret backend (never the keychain).");
}
await rm(root, { recursive: true, force: true });
const stateDir = join(root, "next");
const folder = join(root, "notes");
// Never let the isolated daemon look for today's real connector state.
const env = { ...process.env, MDBASE_CONNECT_HOME: join(root, "no-connect") };
await mkdir(folder, { recursive: true });
await writeFile(join(folder, "hello.md"), "# hello\n");

const profile = await DaemonCli.discover(binary, stateDir, undefined, env);
assert.equal(profile.target, "isolated_profile");
const cli = new DaemonCli(() => binary, profile.target, profile.stateDir, undefined, env);
const session = new DaemonSession({ profile, bundled: { binary, version: "dev" }, cli, reconnectDelaysMs: [100] });
const states = [];
session.subscribe((state) => states.push(state));
const step = (name) => console.log(`ok - ${name}`);
try {
  await session.start();
  assert.equal(session.current.phase, "ready", JSON.stringify(session.current));
  step(`daemon started and attached (${healthLabel(session.current)})`);

  assert.ok(states.some((s) => s.phase === "ready"));
  // Registering needs a signed-in account (the UI asks to sign in first).
  await assert.rejects(session.request("collection.add", { path: folder, name: "Notes" }),
    (error) => error.code === "unauthenticated" && error.reason === "account_identity_missing");
  assert.deepEqual(await session.request("collection.list"), []);
  step("status.subscribe reported ready; collection.add refused until sign-in (typed error); collection.list");

  await assert.rejects(session.request("settings.set", { require_grant_approval: true }),
    (error) => error.code === "permission_denied" || error.code === "unauthenticated" || /auth/i.test(error.message));
  const settings = await cli.run(["settings", "--require-approval", "on"]);
  assert.equal(settings.require_grant_approval, true);
  step("privileged method refused on the app socket and accepted through the CLI");

  const migrate = await session.request("migrate.status");
  assert.equal(migrate.record, null);
  step("migrate.status reports no takeover record");

  const reattached = new Promise((resolve) => {
    let sawDisconnect = false;
    const off = session.subscribe((state) => {
      if (state.phase === "disconnected") sawDisconnect = true;
      if (sawDisconnect && state.phase === "ready") { off(); resolve(); }
    });
  });
  await cli.run(["daemon", "stop"]);
  await reattached;
  step("session restarted the stopped isolated daemon and reattached");
} finally {
  session.stop();
  await cli.run(["daemon", "stop"]).catch(() => undefined);
}
console.log(`states seen: ${[...new Set(states.map((s) => s.phase))].join(", ")}`);
