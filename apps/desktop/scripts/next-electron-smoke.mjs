// Launch the Electron app against a real mdbn-daemon in an isolated profile
// (test secret backend, no service manager) and check it attaches.
//
//   MDBN_DAEMON_BIN=…/mdbase MDBASE_DESKTOP_SMOKE_DIR=<scratch> xvfb-run -a node scripts/next-electron-smoke.mjs
import { _electron as electron } from "playwright-core";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { DaemonCli } = require("../dist/main/daemon-cli.js");
const { requestDaemon } = require("../dist/main/daemon-client.js");

const binary = process.env.MDBN_DAEMON_BIN;
const root = process.env.MDBASE_DESKTOP_SMOKE_DIR;
if (!binary || !root || !isAbsolute(root)) throw new Error("Set MDBN_DAEMON_BIN and an absolute MDBASE_DESKTOP_SMOKE_DIR.");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const stateDir = join(root, "next");
const env = {
  ...process.env,
  MDBN_DAEMON_BIN: binary,
  MDBASE_DESKTOP_STATE_DIR: stateDir,
  MDBASE_CONNECT_HOME: join(root, "no-connect"),
  MDBASE_CONNECT_USER_DATA_DIR: join(root, "electron"),
  MDBASE_ENV: "test",
  MDBASE_SECRET_BACKEND: "insecure-test-file"
};
const app = await electron.launch({
  cwd: resolve(import.meta.dirname, ".."),
  args: [".", `--user-data-dir=${join(root, "electron")}`],
  timeout: 30_000,
  env
});
const profile = await DaemonCli.discover(binary, stateDir, undefined, env);
const cli = new DaemonCli(() => binary, profile.target, profile.stateDir, undefined, env);
try {
  const window = await app.firstWindow({ timeout: 30_000 });
  const status = await window.evaluate(async () => {
    for (let i = 0; i < 100; i += 1) {
      try { return await window.mdbaseConnect.status(); } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    throw new Error("status never succeeded");
  });
  assert.equal(status.readiness.ready, true);
  assert.equal(status.target, "isolated_profile");
  assert.equal(status.state_dir, stateDir);
  console.log(`ok - app started the isolated daemon and read status (version ${status.readiness.binary_version})`);
  // Signed out: the app asks for sign-in before adding a collection. The smoke never
  // starts a sign-in (that would reach a real control plane).
  await window.getByRole("button", { name: "Sign in with your browser" }).waitFor({ timeout: 30_000 });
  const nav = (name) => window.locator(".product-sidebar-link").filter({ hasText: name });
  await nav("Collections").click();
  await window.getByRole("button", { name: "Add existing", exact: true }).click();
  await window.getByText("Sign in first, then add your collection.", { exact: true }).waitFor();
  console.log("ok - signed out: sign-in is offered and Add collection asks for it first");
  // The views read the real daemon through the guarded IPC (owning main frame only).
  await window.getByRole("heading", { name: "No collections yet" }).waitFor();
  await nav("Apps").click();
  await window.getByRole("heading", { name: "No apps connected" }).waitFor();
  await nav("Settings").click();
  await window.getByText("Ask before new apps connect", { exact: true }).waitFor();
  const settings = await window.evaluate(() => window.mdbaseConnect.getSettings());
  assert.equal(typeof settings.require_grant_approval, "boolean");
  assert.ok(Array.isArray(await window.evaluate(() => window.mdbaseConnect.listActivity())));
  await nav("Activity").click();
  await window.getByRole("heading", { name: "Recent activity" }).waitFor();
  console.log("ok - Collections, Apps, Activity and Settings views read the daemon");
  // A fresh profile has no collection. Both calls must reach the daemon and
  // report a missing collection without attempting any hosted sync operation.
  const missingCollection = randomUUID();
  await assert.rejects(
    window.evaluate((id) => window.mdbaseConnect.listHolds(id), missingCollection),
    /no registered collection/
  );
  await assert.rejects(
    window.evaluate((id) => window.mdbaseConnect.enableSync(id, "cloud-copy"), missingCollection),
    /no registered collection/
  );
  console.log("ok - the sync dialog's holds and cloud-copy commands reach the daemon");
  // Quit like the tray does (closing the window only hides it).
  const exited = new Promise((resolve) => app.process().once("exit", resolve));
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await exited;
  const ping = await requestDaemon(profile.control, "ping");
  assert.equal(ping.readiness.ready, true);
  console.log("ok - closing the app leaves the daemon serving");
} finally {
  if (app.process().exitCode === null) app.process().kill();
  await cli.run(["daemon", "stop"]).catch(() => undefined);
}
