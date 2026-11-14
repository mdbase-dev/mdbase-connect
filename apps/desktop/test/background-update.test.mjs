import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  UPDATE_UNIT, updateUnits, registerUpdateTimer,
  claimBackgroundUpdate, releaseBackgroundUpdate, runningBackgroundUpdate, waitForExit
} = require("../dist/main/background-update.js");
const { platformArguments, UPDATE_SWITCH } = require("../dist/main/display-platform.js");

test("Chromium is told to use Wayland when only WAYLAND_DISPLAY says so, and no display for the update", () => {
  const app = ["/opt/mdbase-connect/mdbase-connect", "--hidden"];
  // A systemd user manager: WAYLAND_DISPLAY imported, XDG_SESSION_TYPE missing or "tty".
  for (const session of [undefined, "", "tty"]) {
    assert.deepEqual(platformArguments("linux", app, { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0", XDG_SESSION_TYPE: session }),
      ["/opt/mdbase-connect/mdbase-connect", "--ozone-platform=wayland", "--hidden"]);
  }
  // Chromium's own choice already works, or there is nothing better to choose.
  assert.equal(platformArguments("linux", app, { WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" }), null);
  assert.equal(platformArguments("linux", app, { WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "x11" }), null);
  assert.equal(platformArguments("linux", app, { DISPLAY: ":0" }), null);
  // An explicit choice is kept, which also ends the re-exec after one step.
  for (const chosen of [["--ozone-platform=x11"], ["--ozone-platform", "x11"]]) {
    assert.equal(platformArguments("linux", [...app, ...chosen], { WAYLAND_DISPLAY: "wayland-1" }), null);
  }
  assert.deepEqual(platformArguments("linux", [app[0], UPDATE_SWITCH], {}),
    [app[0], "--ozone-platform=headless", UPDATE_SWITCH]);
  for (const platform of ["darwin", "win32"]) {
    assert.equal(platformArguments(platform, [app[0], UPDATE_SWITCH], { WAYLAND_DISPLAY: "wayland-1" }), null);
  }
});

test("the update units run the app's background update, quoted for systemd, without killing Chromium's children first", () => {
  const { service, timer } = updateUnits("/home/a b/50%$x\"y/mdbase-connect");
  assert.match(service, /^ExecStart="\/home\/a b\/50%%\$\$x\\"y\/mdbase-connect" --mdbase-update$/m);
  assert.match(service, /^ConditionPathExists=\/home\/a b\/50%%\$x"y\/mdbase-connect$/m);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^KillMode=mixed$/m);
  assert.match(timer, /^OnCalendar=\*-\*-\* 00\/6:00:00$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.throws(() => updateUnits("/home/a\n/mdbase-connect"), /cannot be written/);
});

test("registering writes the units once, reloads only after a change, and always enables the timer", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "mdbase-update-timer-"));
  const calls = [];
  const run = async (args) => { calls.push(args); };
  await registerUpdateTimer("/opt/a/mdbase-connect", configHome, run);
  const directory = join(configHome, "systemd", "user");
  assert.equal(await readFile(join(directory, `${UPDATE_UNIT}.service`), "utf8"), updateUnits("/opt/a/mdbase-connect").service);
  assert.equal(await readFile(join(directory, `${UPDATE_UNIT}.timer`), "utf8"), updateUnits("/opt/a/mdbase-connect").timer);
  assert.deepEqual(calls, [["daemon-reload"], ["enable", "--now", `${UPDATE_UNIT}.timer`]]);

  calls.length = 0;
  await registerUpdateTimer("/opt/a/mdbase-connect", configHome, run);
  assert.deepEqual(calls, [["enable", "--now", `${UPDATE_UNIT}.timer`]]);

  calls.length = 0;
  await registerUpdateTimer("/opt/moved/mdbase-connect", configHome, run);
  assert.deepEqual(calls[0], ["daemon-reload"]);
  assert.match(await readFile(join(directory, `${UPDATE_UNIT}.service`), "utf8"), /opt\/moved/);

  await assert.rejects(registerUpdateTimer("/opt/a/mdbase-connect", configHome, async () => {
    throw new Error("systemctl --user daemon-reload failed: Failed to connect to bus");
  }), /Failed to connect to bus/);
});

test("a launch waits only for a live background update, and a run removes only its own marker", async () => {
  const userData = await mkdtemp(join(tmpdir(), "mdbase-update-marker-"));
  const proc = join(userData, "proc");
  const cmdline = async (pid, argv) => {
    await mkdir(join(proc, String(pid)), { recursive: true });
    await writeFile(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
  };
  assert.equal(runningBackgroundUpdate(userData, proc), null);

  await claimBackgroundUpdate(userData, 4242);
  assert.equal((await stat(join(userData, "updates", "background-update.pid"))).mode & 0o777, 0o600);
  assert.equal(runningBackgroundUpdate(userData, proc), null, "no such process");
  await cmdline(4242, ["/opt/mdbase-connect/mdbase-connect", "--hidden"]);
  assert.equal(runningBackgroundUpdate(userData, proc), null, "the PID was reused by another process");
  await cmdline(4242, ["/opt/mdbase-connect/mdbase-connect", "--ozone-platform=headless", UPDATE_SWITCH]);
  assert.equal(runningBackgroundUpdate(userData, proc), 4242);

  await claimBackgroundUpdate(userData, 5151);
  await releaseBackgroundUpdate(userData, 4242);
  await cmdline(5151, ["mdbase-connect", UPDATE_SWITCH]);
  assert.equal(runningBackgroundUpdate(userData, proc), 5151, "an earlier run leaves a later run's marker");
  await releaseBackgroundUpdate(userData, 5151);
  assert.equal(runningBackgroundUpdate(userData, proc), null);
});

test("waiting for a background update ends when it exits, or at the limit", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
  const started = Date.now();
  await waitForExit(child.pid, 10_000, 20);
  assert.ok(Date.now() - started < 5_000);
  const forever = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  try {
    const before = Date.now();
    await waitForExit(forever.pid, 100, 20);
    assert.ok(Date.now() - before >= 100);
  } finally {
    forever.kill();
  }
});
