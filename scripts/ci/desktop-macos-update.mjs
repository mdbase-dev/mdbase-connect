// Proves that a published, signed macOS Desktop updates itself to the newest
// release (`.github/workflows/desktop-macos-update.yml`).
//
//   plan   chooses the pair of releases and writes them to GITHUB_OUTPUT
//   drive  runs the installed older app until it has relaunched on the newer one
//
// The app finds its update the way every installation does: its first automatic
// check, 30 seconds after launch, reads the signed channel of the newest
// published release (docs/desktop-updates.md). The test reads the app's update
// status and presses Restart and update through the same preload API as the
// window, over Chromium's remote debugging port.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { releaseList } from "../continuous-desktop-release.mjs";

export const APP = "/Applications/mdbase connect.app";
const EXECUTABLE = "mdbase-connect";
const MINUTE = 60_000;

/** `v0.1.0-beta.190` from `0.1.0-beta.190` or `v0.1.0-beta.190`; undefined when empty. */
export function releaseTag(input) {
  const value = (input ?? "").trim();
  if (!value) return undefined;
  const tag = value.startsWith("v") ? value : `v${value}`;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Not a release version: ${value}`);
  return tag;
}

/**
 * The older release to install and the release it must update to, from the
 * published desktop releases newest first (`releaseList`). `to` defaults to the
 * newest and `from` to the one before `to`.
 *
 * Returns `{ skip }` when either is an explicitly unsigned macOS preview: those
 * are manual downloads, never automatic targets, so nothing updates itself.
 */
export function updatePair({ releases, arch, from, to }) {
  assert.match(arch, /^(?:arm64|x64)$/);
  const newest = releases[0];
  if (!newest) throw new Error("No desktop release has been published.");
  const toTag = releaseTag(to) ?? newest.tag_name;
  const toIndex = releases.findIndex((release) => release.tag_name === toTag);
  if (toIndex === -1) throw new Error(`${toTag} is not a published desktop release.`);
  if (toIndex !== 0) {
    throw new Error(`${toTag} is not the newest desktop release (${newest.tag_name}). An installed app always updates to the newest, so it cannot test ${toTag}.`);
  }
  const fromTag = releaseTag(from);
  const fromIndex = fromTag ? releases.findIndex((release) => release.tag_name === fromTag) : toIndex + 1;
  if (fromIndex === -1) throw new Error(`${fromTag} is not a published desktop release.`);
  if (fromIndex <= toIndex) throw new Error(`${fromTag} is not older than ${toTag}.`);
  const older = releases[fromIndex];
  if (!older) throw new Error(`No desktop release was published before ${toTag}.`);

  const signed = (release, extension) => {
    const version = release.tag_name.slice(1);
    const names = release.assets.map((asset) => asset.name);
    if (names.some((name) => name.startsWith(`mdbase-connect-${version}-macos-${arch}-UNSIGNED`))) return null;
    const name = `mdbase-connect-${version}-macos-${arch}.${extension}`;
    if (!names.includes(name)) throw new Error(`${release.tag_name} has neither a signed nor an unsigned macOS ${arch} ${extension}.`);
    return name;
  };
  const dmg = signed(older, "dmg");
  const zip = signed(releases[toIndex], "zip");
  const unsigned = [!dmg && older.tag_name, !zip && toTag].filter(Boolean);
  if (unsigned.length) {
    return {
      skip: `${unsigned.join(" and ")} ${unsigned.length > 1 ? "are" : "is an"} explicitly unsigned macOS preview${unsigned.length > 1 ? "s" : ""}. Unsigned previews never update automatically, so there is nothing to test.`
    };
  }
  return { from: older.tag_name, to: toTag, dmg };
}

export function plan(env = process.env, releases = releaseList()) {
  const result = updatePair({ releases, arch: env.ARCH, from: env.FROM, to: env.TO });
  const outputs = result.skip
    ? { skip: "true", reason: result.skip }
    : { skip: "false", from: result.from, to: result.to, dmg: result.dmg };
  console.log(result.skip ? `::notice title=Skipped::${result.skip}` : `${result.from} -> ${result.to} (${env.ARCH})`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
  return result;
}

// --- Driving the installed app (macOS only) ---

const started = Date.now();
function step(text) {
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}] ${text}`);
}

function bundleVersion() {
  return execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(APP, "Contents/Info.plist")],
    { encoding: "utf8" }).trim();
}

/** PIDs of the app's main process (helpers are named `mdbase-connect Helper…`). */
function mainProcesses() {
  const result = spawnSync("pgrep", ["-x", EXECUTABLE], { encoding: "utf8" });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`pgrep failed: ${result.stderr}`);
  return result.stdout.split("\n").filter(Boolean).map(Number);
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function until(what, limitMs, probe) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${Math.round(limitMs / 1000)} s waiting for ${what}.`);
    await sleep(1000);
  }
}

function newMainProcess(previous, limitMs) {
  return until("the app's main process", limitMs, () => {
    const pids = mainProcesses().filter((pid) => pid !== previous);
    if (pids.length > 1) throw new Error(`Several app processes are running: ${pids.join(", ")}.`);
    return pids[0];
  });
}

/** A Chrome DevTools Protocol session on the app's window (Node's own WebSocket). */
async function windowSession(port, limitMs) {
  const target = await until("the app's window", limitMs, async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
      return (await response.json()).find((item) => item.type === "page" && item.url.startsWith("file:"));
    } catch {
      return undefined;
    }
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not open the app's debugging connection.")), { once: true });
  });
  const pending = new Map();
  let next = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  socket.addEventListener("close", () => {
    for (const settle of pending.values()) settle({ error: { message: "The app closed its debugging connection." } });
    pending.clear();
  });
  return {
    /** Evaluates `expression` in the window and returns its awaited value. */
    async evaluate(expression) {
      const id = ++next;
      const reply = new Promise((settle) => pending.set(id, settle));
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      const message = await Promise.race([reply, sleep(30_000).then(() => ({ error: { message: `No answer to ${expression}.` } }))]);
      if (message.error) throw new Error(message.error.message);
      if (message.result.exceptionDetails) {
        throw new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text);
      }
      return message.result.result.value;
    },
    /** Sends `expression` without waiting: the app may quit while it runs. */
    send(expression) {
      socket.send(JSON.stringify({ id: ++next, method: "Runtime.evaluate", params: { expression } }));
    },
    close() {
      socket.close();
    }
  };
}

async function launch(label, { port, logDir }) {
  execFileSync("open", ["-n", "-a", APP, "--stdout", join(logDir, `${label}.stdout.log`),
    "--stderr", join(logDir, `${label}.stderr.log`), "--args", `--remote-debugging-port=${port}`]);
  const pid = await newMainProcess(undefined, MINUTE);
  const window = await windowSession(port, 2 * MINUTE);
  step(`${label}: app ${bundleVersion()} running as PID ${pid}`);
  return { pid, window };
}

async function quit(pid) {
  process.kill(pid, "SIGTERM");
  try {
    await until(`PID ${pid} to quit`, 30_000, () => !alive(pid));
  } catch {
    process.kill(pid, "SIGKILL");
  }
}

const STATUS = "window.mdbaseConnect.updateStatus()";
const CHECK_RETRIES = 2;

export async function drive(env = process.env) {
  const from = releaseTag(env.FROM).slice(1);
  const to = releaseTag(env.TO).slice(1);
  const options = { port: Number(env.DEBUG_PORT ?? 9333), logDir: resolve(env.LOG_DIR) };
  assert.equal(bundleVersion(), from, "The installed app is not the older release.");

  const older = await launch("older", options);
  let status = await older.window.evaluate(STATUS);
  assert.equal(status.current_version, from);
  let phase;
  // A failed check is retried only at the next six-hourly check. GitHub can
  // refuse a shared runner's address (HTTP 403), so a failed check is repeated
  // with Check now, at most twice and 30 seconds apart, through the same feed.
  let checksLeft = CHECK_RETRIES;
  let retryAt = 0;
  // When Check now was pressed; a check that failed too fast to be seen
  // checking again counts as failed after 90 seconds.
  let pressedAt = 0;
  await until("the update to be downloaded and staged", 10 * MINUTE, async () => {
    if (!alive(older.pid)) throw new Error("The app exited before its update was ready.");
    status = await older.window.evaluate(STATUS);
    if (status.phase !== phase) {
      phase = status.phase;
      step(`update ${phase}${status.target_version ? ` ${status.target_version}` : ""}: ${status.message}`);
      pressedAt = 0;
      if (phase === "failed" && checksLeft > 0) retryAt = Date.now() + 30_000;
    }
    if (phase === "idle" && status.checked_at) throw new Error("The app found no newer release.");
    if (phase === "failed" && (retryAt || Date.now() - pressedAt < 90_000)) {
      if (retryAt && Date.now() >= retryAt) {
        checksLeft -= 1;
        retryAt = 0;
        pressedAt = Date.now();
        console.log(`::warning title=Update check retried::${status.message} Pressing Check now (${CHECK_RETRIES - checksLeft} of ${CHECK_RETRIES}).`);
        // Not awaited: the check also downloads, which outlasts one evaluation.
        older.window.send("window.mdbaseConnect.checkForUpdates()");
      }
      return false;
    }
    if (["failed", "external", "deferred", "unavailable"].includes(phase)) throw new Error(`The update stopped: ${phase}.`);
    return phase === "ready";
  });
  assert.equal(status.target_version, to, "The app staged a different release.");

  step("Restart and update");
  older.window.send("window.mdbaseConnect.installUpdate()");
  await until("the older app to quit", 2 * MINUTE, () => !alive(older.pid));
  older.window.close();
  const relaunched = await newMainProcess(older.pid, 3 * MINUTE);
  const installed = bundleVersion();
  step(`relaunched as PID ${relaunched}, bundle version ${installed}`);
  assert.equal(installed, to, "The relaunched app is not the newer release.");
  execFileSync("codesign", ["--verify", "--deep", "--strict", APP], { stdio: "inherit" });

  // The version the running app reports, not only the bundle's Info.plist.
  await quit(relaunched);
  const newer = await launch("newer", options);
  status = await newer.window.evaluate(STATUS);
  assert.equal(status.current_version, to, "The updated app reports another version.");
  newer.window.close();
  await quit(newer.pid);
  step(`updated ${from} -> ${to}`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY,
      `macOS ${env.ARCH ?? ""} Desktop updated itself from ${from} to ${to} in ${Math.round((Date.now() - started) / 1000)} s.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const commands = { plan, drive };
  const command = commands[process.argv[2]];
  if (!command) throw new Error("Expected plan or drive.");
  await command();
}
